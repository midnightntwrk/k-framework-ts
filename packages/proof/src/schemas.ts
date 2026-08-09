/**
 * Structural schemas for proof-directory wire documents.
 *
 * These schemas intentionally stop at the plain-data boundary.  KAST, KCFG,
 * CSubst, and rewrite-log documents still go through their existing decoders,
 * which own their domain and cross-reference validation.
 */

import { z } from "zod";

/** The three derived proof-status spellings.  A composition building block only. */
export const proofStatusSchema = z.enum(["passed", "failed", "pending"]);

/** The common JSON prefix every persisted proof document carries. */
export const proofJsonBaseSchema = z.object({
  id: z.string(),
  subproof_ids: z.array(z.string()).default([]),
  admitted: z.boolean().default(false),
});

/** A JSON object keyed by node id, restored to the map shape proof code uses. */
export function nodeIdMapSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .record(z.string(), valueSchema)
    .transform(
      (entries): Map<number, z.output<T>> =>
        new Map(Object.entries(entries).map(([key, value]) => [Number(key), value])),
    );
}

const nodeIdSchema = z.union([z.number(), z.string()]);

/** Embedded-KCFG `APRProof.dict` wire document, not an `APRProof` instance. */
const aprProofDictSchemaDefinition = proofJsonBaseSchema.extend({
  type: z.literal("APRProof"),
  kcfg: z.unknown(),
  terminal: z.array(z.number()),
  init: nodeIdSchema,
  target: nodeIdSchema,
  bounded: z.array(z.number()),
  bmc_depth: nodeIdSchema.optional(),
  node_refutations: nodeIdMapSchema(z.string()).default(new Map()),
  circularity: z.boolean().default(false),
  // `decodeProofLogs` remains the only log-entry decoder.
  logs: z.unknown().optional(),
});

/** JSON-compatible input accepted by {@link aprProofDictSchema}. */
export type AprProofDictInput = z.input<typeof aprProofDictSchemaDefinition>;
/** Decoded structural output, including restored node-id maps. */
export type AprProofDict = z.output<typeof aprProofDictSchemaDefinition>;
export const aprProofDictSchema: z.ZodType<AprProofDict, AprProofDictInput> = aprProofDictSchemaDefinition;

/** Proof-directory `proof.json` document for an APR proof, not an `APRProof` instance. */
const aprProofDataSchemaDefinition = proofJsonBaseSchema.extend({
  type: z.literal("APRProof"),
  execution_time: z.number().optional(),
  init: nodeIdSchema,
  target: nodeIdSchema,
  terminal: z.array(z.number()),
  node_refutations: nodeIdMapSchema(z.string()),
  circularity: z.boolean(),
  // `decodeProofLogs` remains the only log-entry decoder.
  logs: z.unknown(),
  bounded: z.array(z.number()),
  bmc_depth: nodeIdSchema.optional(),
  loops_cache: nodeIdMapSchema(z.array(z.number())).default(new Map()),
});

/** JSON-compatible input accepted by {@link aprProofDataSchema}. */
export type AprProofDataInput = z.input<typeof aprProofDataSchemaDefinition>;
/** Decoded proof-directory output, including restored node-id maps. */
export type AprProofData = z.output<typeof aprProofDataSchemaDefinition>;
export const aprProofDataSchema: z.ZodType<AprProofData, AprProofDataInput> = aprProofDataSchemaDefinition;

/** Implies-family proof wire document, not an `ImpliesProof` instance. */
const impliesProofDictSchemaDefinition = proofJsonBaseSchema.extend({
  type: z.enum(["ImpliesProof", "EqualityProof", "RefutationProof"]),
  // Unlike APR's historic decoder, implies-family persistence requires this field.
  subproof_ids: z.array(z.string()),
  // KAST and CSubst construction remains with their established decoders.
  antecedent: z.unknown(),
  consequent: z.unknown(),
  simplified_antecedent: z.unknown().optional(),
  simplified_consequent: z.unknown().optional(),
  csubst: z.unknown().optional(),
});

/** JSON-compatible input accepted by {@link impliesProofDictSchema}. */
export type ImpliesProofDictInput = z.input<typeof impliesProofDictSchemaDefinition>;
/** Decoded implies-family structural output; never a domain model. */
export type ImpliesProofDict = z.output<typeof impliesProofDictSchemaDefinition>;
export const impliesProofDictSchema: z.ZodType<ImpliesProofDict, ImpliesProofDictInput> =
  impliesProofDictSchemaDefinition;
