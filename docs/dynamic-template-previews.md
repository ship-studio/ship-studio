# Dynamic template previews

The Pages panel treats a dynamic route as a template. Selecting it navigates
to the currently displayed entry when it belongs to that template, or the
first available entry. The toolbar picker stays closed until opened so you can
switch to another concrete route. Astro templates are enumerated by starting a
short-lived Astro dev server on loopback with an ephemeral port, then calling
that page's `getStaticPaths` through Astro's Vite SSR loader. Imported
TypeScript, Astro content collections, and project integrations run in Astro's
dev context. The `paginate()` helper provides Astro's `props.page` pagination
metadata and generates page params for the provided data array. Ship Studio does not guess
slugs or run a full site build. It writes no project source or configuration;
Astro may create its normal `.astro` metadata and Vite cache files during
startup.

Next.js evaluates Pages Router `getStaticPaths` with configured locale data and App Router
`generateStaticParams`; SvelteKit reads a route's `entries` exports and
configured prerender routes; Nuxt reads configured Nitro prerender routes,
including routes added by Nuxt's `nitro:config` hook. These integrations run
in a bounded Node process. Nuxt 3 `pages/`, Nuxt 4 `app/pages/`, and a
literal string `srcDir` setting in `nuxt.config` are supported by both the
inventory and entry runner; computed values cannot be resolved by the
inventory. Next.js dynamic entry discovery requires Node.js 22.15 or
newer. It reads JSONC TypeScript path aliases and their local `extends` chain,
but aliases implemented only in custom webpack configuration are not available
to its lightweight loader.
SvelteKit may create its normal `.svelte-kit` cache during startup; Nuxt may
create its normal `.nuxt` cache. Projects can also provide an explicit route
list in `.shipstudio/template-entries.json`:

```json
{
  "version": 1,
  "templates": {
    "/work/:slug": [
      { "route": "/work/glow", "label": "Glow" },
      { "route": "/work/kinetic", "label": "Kinetic" }
    ]
  }
}
```

The template key must match the route shown in the Pages panel. Entry routes
must be concrete local paths beginning with `/`; include any configured base
path and trailing slash in the value. Labels are optional in practice: an
empty label falls back to the route. The list is capped at 500 entries.

When a manifest entry exists for a route it is used as the explicit source of
truth. Without one, Ship Studio asks the detected framework for entries. If a
framework has no configured entries (for example, an on-demand dynamic route),
add them to the manifest.
