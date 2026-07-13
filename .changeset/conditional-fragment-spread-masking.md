---
'@graphql-codegen/visitor-plugin-common': patch
'@graphql-codegen/client-preset': patch
---

Keep fragment masking for fragment spreads annotated with `@include`/`@skip`.

With `inlineFragmentTypes: 'mask'`, conditional fragment spreads were inlined into the parent operation type as optional fields, silently dropping the `' $fragmentRefs'` masking reference (the `@defer` path already preserved masking). They now emit an optional ref instead:

```ts
{ ' $fragmentRefs'?: { 'XFragment'?: XFragment } }
```

A spread carrying both a conditional and an incremental directive emits `' $fragmentRefs'?: { 'XFragment'?: Incremental<XFragment> }` instead of the previous double emission of inlined optional fields alongside the deferred ref.

The client preset's fragment-masking helpers gain an `OptionalFragmentType` type (accepts parents whose fragment may be absent; `FragmentType` remains assignable to it) and matching `useFragment` overloads that return `TType | undefined`, so conditional fragment refs can be consumed without casts. Existing overloads are unchanged, and unconditional refs still unmask to `TType`.
