import safeRegex from "safe-regex";

const MAX_SCHEMA_SERIALIZED_LENGTH = 20_000; // 20 KB
const MAX_SCHEMA_DEPTH = 20; // nesting depth
const MAX_PATTERN_LENGTH = 200; //

export interface SchemaSafetyCheckResult {
  isSafe: boolean;
  errors?: string[];
}

export function checkSchemaComplexity(schema : unknown) : SchemaSafetyCheckResult {
  // stp 1 : json -> string
  const serialized = JSON.stringify(schema);

  // step 2 : check validity of the serialized schema
  if (schema == undefined ){
    return {
      isSafe: false,
      errors : ["schema couldn't be serialized"]
    }
  }

  if (serialized.length > MAX_SCHEMA_SERIALIZED_LENGTH) {
    return {
      isSafe: false,
      errors: [`Schema is too large: ${serialized.length} bytes (max ${MAX_SCHEMA_SERIALIZED_LENGTH})`],
    };
  }

  // step 3 : check depth of the schema
  const depth = measureDepth(schema);
  if (depth > MAX_SCHEMA_DEPTH) {
    return {
      isSafe: false,
      errors: [`Schema is too deep: ${depth} (max ${MAX_SCHEMA_DEPTH})`],
    };
  }

  return { isSafe: true };

}


export function scanForUnsafeRegexPatterns(schema: unknown): SchemaSafetyCheckResult {
  const patterns = collectRegexPatterns(schema);

  const errors: string[] = [];
  for (const pattern of patterns) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      errors.push(`Regex pattern is too long: ${pattern.length} characters (max ${MAX_PATTERN_LENGTH})`);
      continue;
    }

    try{
      new RegExp(pattern);
    } catch (error) {
      errors.push(`pattern is not a syntactically valid regular expression: "${pattern}"`);
      continue;
    }

    if (!safeRegex(pattern)) {
      errors.push(`pattern flagged as a potential catastrophic-backtracking risk: "${pattern}"`);
    }

  }

  return errors.length > 0 ? { isSafe: false, errors } : { isSafe: true };
}


function measureDepth(value : unknown  , curr = 0) : number {
  if(curr > MAX_SCHEMA_DEPTH + 3) return curr;

  if (value && typeof value === "object") {
    let maxChildDepth = curr;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      maxChildDepth = Math.max(maxChildDepth, measureDepth(key , curr + 1));
    }
    return maxChildDepth;
  }

  if (Array.isArray(value)) {
    let maxChildDepth = curr;
    for (const item of value){
      maxChildDepth = Math.max(maxChildDepth, measureDepth(item , curr + 1));
    }
    return maxChildDepth;
  }

  return curr;
}



function collectRegexPatterns(schema: unknown, patterns: string[] = []) : string[]{
  if(Array.isArray(schema)){
    for(const item of schema){
      collectRegexPatterns(item, patterns);
    }
  }else if(schema && typeof schema === "object"){
    for (const [key , val] of Object.entries(schema as Record<string, unknown>)){
      if(key === "pattern" && typeof val === "string"){
        patterns.push(val);
      }
      if(key === "patternProperties" && typeof val === "object"){
        for(const pattern of Object.keys(val as Record<string, unknown>)){
          patterns.push(pattern);
        }
      }
      collectRegexPatterns(val, patterns);
    }
  }
  return patterns;
}