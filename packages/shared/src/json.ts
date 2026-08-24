export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === '[object String]';
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === '[object Number]';
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === '[object Boolean]';
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}
