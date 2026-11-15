import { z } from "zod";

/** Every v1 contract carries this literal; a different value is rejected, not coerced. */
export const CONTRACT_SCHEMA_VERSION = 1;

export const schemaVersionV1 = z.literal(CONTRACT_SCHEMA_VERSION);
