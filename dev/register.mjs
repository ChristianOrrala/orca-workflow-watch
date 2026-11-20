// Lets plain Node load the plugin's TypeScript the way Orca does: `./model` finds `model.ts`.
// Node 23.6+ strips the types itself. Used by dev/preview.mjs only.
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
          try { return await next(specifier + '.ts', context) } catch {}
        }
        return next(specifier, context)
      }
    `),
  import.meta.url,
)
