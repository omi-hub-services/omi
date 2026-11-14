import { z } from "zod";
import { identifierSchema } from "./identifiers.js";

/** Input of `refresh --run`: only the run id; heads and bases come from runtime records. */
export const refreshRunSchema = z.strictObject({ runId: identifierSchema });
