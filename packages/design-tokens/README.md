# Shared design tokens

`@slopbot/design-tokens` is the source of truth for the cross-platform Lyra design language.

- Web: shadcn/ui `base-lyra`, Base UI, Tailwind CSS variables in `apps/web/app/globals.css`.
- Android: React Native Reusables + NativeWind variables in `apps/mobile/global.css`; native navigation and inline styles read this package through `apps/mobile/lib/theme.ts`.
- Desktop: Electrobun system-webview CSS in `apps/desktop/src/mainview/index.css` uses the same semantic variables.

The platforms share semantic tokens and visual intent, not DOM/native component implementations. Change `src/index.ts` first, then synchronize the CSS variable maps. `tests/design-tokens.test.ts` fails if the platform palettes drift.
