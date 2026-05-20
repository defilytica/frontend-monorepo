import { CodegenConfig } from '@graphql-codegen/cli'

/**
 * Two modes:
 *
 *   default                    schema source = local `./schema.graphql`
 *                              (tracked in git). Zero network. Used by
 *                              `pnpm graphql:gen`, the dev `--watch`
 *                              loop, and CI/CD builds.
 *
 *   REFRESH_SCHEMA=1           schema source = api-v3 over HTTP. Also
 *                              emits the schema-ast back to
 *                              `./schema.graphql`, so this is the
 *                              command contributors run when api-v3's
 *                              schema actually changes. Used by
 *                              `pnpm graphql:refresh-schema`.
 *
 * Moving the schema source off api-v3 by default removes the
 * persistent Cloudflare 1015 the dev codegen step was producing —
 * codegen ran in watch mode and re-fetched the schema on every
 * document change, which compounded with the runtime queries to trip
 * the per-IP rate limit during active dev. See PHASE_B_HANDOFF §18.
 */

const REFRESH = process.env.REFRESH_SCHEMA === '1'
const REMOTE_SCHEMA_URL = process.env.NEXT_PUBLIC_BALANCER_API_URL as string

const remoteSchema = {
  [REMOTE_SCHEMA_URL]: {
    headers: {
      // Prevent gzip-compressed responses that the schema loader can't decompress
      'Accept-Encoding': 'identity',
    },
  },
}

const config: CodegenConfig = {
  schema: REFRESH ? remoteSchema : './shared/services/api/schema.graphql',
  generates: {
    // Only emit the schema-ast when refreshing from the remote — in
    // default mode the file is the *input*, so emitting it back is
    // redundant (and noisy in git diffs).
    ...(REFRESH
      ? {
          ['./shared/services/api/schema.graphql']: {
            plugins: ['schema-ast'],
          },
        }
      : {}),
    [`./shared/services/api/generated/`]: {
      documents: ['./shared/services/api/**/*.graphql'],
      preset: 'client',
      presetConfig: {
        fragmentMasking: false,
      },
      config: {
        nonOptionalTypename: true,
        scalars: {
          BigInt: 'string',
          BigDecimal: 'string',
          Bytes: 'string',
          AmountHumanReadable: 'string',
          GqlBigNumber: 'string',
        },
      },
    },
  },
}

export default config
