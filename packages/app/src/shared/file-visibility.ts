import * as v from 'valibot';

export const fileVisibilitySchema = v.picklist(['public', 'private', 'passphrase']);
export type FileVisibility = v.InferOutput<typeof fileVisibilitySchema>;
