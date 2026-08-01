import {Ajv}  from "ajv";
import type { ValidateFunction } from "ajv/dist/types/index.js";
import { McpGatewayError } from "../errors/mcp-error-taxonomy.js";

/**
 * LRU-bounded cache of compiled JSON Schema 2020-12 validators.
 *
 * - `strict: false` aligns with Week 2's schema-validator.ts.
 * - Compile failures are caught and surfaced as SERVICE_DEGRADED.
 * - **True memory bounding**: stores the schema object alongside the compiled
 *   function so that eviction can call `ajv.removeSchema()`, preventing the
 *   internal Ajv cache from growing without bound when schemas are fetched
 *   from the database (each fetch creates a new object reference).
 */
export class AjvValidatorCache {
  private readonly ajv: Ajv;
  private readonly cache = new Map<
    string,
    { validate: ValidateFunction; schema: object }
  >();
  private readonly maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.ajv = new Ajv({
      strict: false,
      allErrors: true,
      useDefaults: true,
      coerceTypes: false,
    });
  }

  getOrCompile(toolId: string, schema: object): ValidateFunction {
    const existing = this.cache.get(toolId);
    if (existing) {
      // LRU refresh: move to end
      this.cache.delete(toolId);
      this.cache.set(toolId, existing);
      return existing.validate;
    }

    let validate: ValidateFunction;
    try {
      validate = this.ajv.compile(schema);
    } catch (err) {
      throw McpGatewayError.fromSignal("SERVICE_DEGRADED", {
        reason: "schema_compilation_failed",
        toolId,
      });
    }

    // Evict LRU if at capacity, and remove from Ajv's internal cache
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.cache.get(oldestKey);
        if (oldest) {
          this.ajv.removeSchema(oldest.schema); // critical for memory bounding
        }
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(toolId, { validate, schema });
    return validate;
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      this.ajv.removeSchema(entry.schema);
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const globalValidatorCache = new AjvValidatorCache(500);