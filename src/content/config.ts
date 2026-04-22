import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/blog', ignore: ['_*', 'README*', 'LICENSE*'] }),
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
