# Requires just 1.23.0 or later.
import 'just/loader.just'

# List available recipes
default:
    @just --list

# Keep the repository's tested npm policy when adopting Tailor's layout.
set allow-duplicate-recipes := true

# Build the card using the pinned npm toolchain.
build:
    npm run build

# Run focused unit and contract tests; real-service probes are explicit.
test:
    npm run test:unit

# Preserve ESLint as the source policy.
lint:
    npm run lint

typecheck:
    npm run typecheck

probe:
    npm run test:probe
