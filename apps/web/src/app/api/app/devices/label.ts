import { z } from 'zod';

/** Longest label accepted before normalization (the stored label is cut to 64 characters). */
const LABEL_INPUT_MAX = 256;

/** A device label as a client sends it, when pairing (pairing-codes) and when renaming. */
export const labelInput = z.string().max(LABEL_INPUT_MAX);
