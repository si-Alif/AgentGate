import {Ajv} from "ajv";
import { checkSchemaComplexity, scanForUnsafeRegexPatterns } from "./schema-safety.js";

const ajv = new Ajv({ strict: false, allErrors: true });

export interface SchemaValidationResult {
  valid: boolean;
  errors?: string[] | undefined;
  failedGate ?: "structural" | "complexity" | "pattern_safety";
}


export function validateJsonSchema(schema : object) : SchemaValidationResult {
  try{
    const structurallyValid = ajv.validateSchema(schema);
    if(!structurallyValid){
      return {
        valid: false,
        failedGate: "structural",
        errors: (ajv.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`),
      }
    }
  }catch{
    return {
      valid: false,
      failedGate: "structural",
      errors: ["schema could not be parsed as a valid JSON Schema"],
    };
  }

  const complexity = checkSchemaComplexity(schema);
  if(!complexity.isSafe){
    return { valid: false, failedGate: "complexity", errors: complexity.errors };
  }

  const patternSafety = scanForUnsafeRegexPatterns(schema);
  if(!patternSafety.isSafe){
    return { valid: false, failedGate: "pattern_safety", errors: patternSafety.errors };
  }

  return { valid: true };
}