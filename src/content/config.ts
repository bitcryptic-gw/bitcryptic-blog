import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title:       z.string(),
    slug:        z.string(),
    date:        z.coerce.date(),
    updated:     z.coerce.date().optional(),
    author:      z.string().default('BitCryptic'),
    tags:        z.array(z.string()).default([]),
    description: z.string(),
    status:      z.enum(['draft', 'published']).default('draft'),
  }),
});

export const collections = { blog };
