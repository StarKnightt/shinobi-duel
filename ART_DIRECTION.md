# Shinobi Duel — Art Direction

Every visual change has to follow this page. If a change breaks a rule here, change the change, not the rule.

## Mood

Two blades on a frozen roof at the top of the world, at night, in a wind that wants you dead.

## What the references taught us

From the images in `refs/` and frames from all three clips:

- **The world is grey.** In the Isshin fight the world is silver-grey pampas grass and slate stone under a dim sky. Saturation lives only in the fighters and the effects. That restraint is what makes a deflect feel like an explosion.
- **The hero is the warmest thing on screen.** Sekiro's burnt-orange coat and red scarf read against cold grey in every shot, even when tiny or backlit. You can always find him.
- **Each color means one thing.**
  - Orange-white means steel on steel (deflect sparks, the long flare line).
  - Red means danger (the 危 kanji, blood, the posture-break bead).
  - Purple means the uncanny: Inner Isshin's sparks, the Mortal Blade, the spirit emblems.
  - The colors never mix their jobs.
- **Shadows are deep but never dead.** Shadow sides of faces and armour sit around 10-15% brightness with a cool tint. You can still read cloth folds.
- **Effects are short and bright, and their afterglow is long and dim.** The deflect core is gone in 0.15 s. The flare line, the light on the ground and the embers hang on for half a second or more.
- **Wind moves everything:** grass, cloth, embers, snow. Nothing in a frame is still.
- **The big moments are graphic.** The ending is warm sepia gold. "不死斬り" sits as a white vertical brush column with tiny letters underneath. Those are posters.

## Palette

Four colors. Everything on screen is one of these, or a darker or lighter shade of one.

| Role | Name | Hex | Used for |
|---|---|---|---|
| World | **Moon slate** | `#141B27` → `#5E6B82` → `#B7C3D8` | Sky, snow, stone, cloud sea, mountains, the boss's armour. All cold, low saturation. |
| Heat | **Ember** | `#FF8A3C` (core `#FFE2B8`) | Deflect sparks, lanterns, windows, the warm bounce on the fighters. The only warm light in the world. |
| Danger | **Blood** | `#B3121E` (bright `#FF3A28`) | Her scarf and sash, blood and ink, the peril kanji, the posture-break bead, the boss's phase-2 rage, the finisher moon. |
| Uncanny | **Curse violet** | `#7A3BD6` (core `#D9B8FF`, edge `#1A0B2A`) | Cursed Blade (ability 1) and nothing else. Purple fire is dark at the edges and pale at the heart, never neon. |

**One exception: healing jade** `#7FD8B0`. It's soft, low in intensity and short, and used only for the gourd heal. It must never come back in any other effect.

## Light

- **Key light: the moon.** It sits high in front of the camera, behind the keep. The fighters are lit from behind and to the side, which gives every silhouette a **cold silver rim** (`#C8D6FF`). It's the strongest light on the characters and the reason they pop.
- **Fill: cool sky light from the camera side.** It's soft and about 30% of the key. Faces, costumes and the boss's armour plates read clearly, but the fill never flattens the form. The shadow side stays darker than the lit side.
- **Bounce: warm and local.** The lanterns, and briefly the sparks, throw ember-colored light onto whatever is near them. It's a gift, not a constant.
- **Effects are the only other light sources.** The deflect flash, the firecracker burst and the curse glow light the fighters and the snow for a moment. Afterwards the scene drops back to moonlight.
- **The fighters are always brighter than whatever is directly behind them.** That holds in every shot, and the rim light is what guarantees it.

## Shadow

- The darkest values in the world are about 4-6% luminance, tinted blue-black. Never pure black, never crushed.
- Character shadow sides sit at 10-15%. You can still read the cloth.
- Contact shadows under feet are the darkest thing on the floor, so the fighters stand on the roof instead of floating above it.

## Silhouettes

**The kunoichi (player)**
- Slim and vertical. A single bright line of katana.
- Her signature is the **blood-red scarf and sash ribbons streaming downwind**. They should be readable as a shape at thumbnail size.
- She is warm against a cold world, and the warmest figure on screen except for effects.
- Abilities may change her glow (curse violet, heal jade), but never her shape. You must still see her.

**The general (boss)**
- Wide and heavy, a triangle: broad sode shoulders, the cape, a low stance.
- The **horned kabuto must break the skyline or the moon** in key shots. The horns are his signature.
- His armour is dark lacquer in moon slate, defined by the rim catching the edges and the plates. He is never lit warmer than she is.
- **Phase 2:** his colors stay the same, but blood-red and black heat comes off him: embers rising, heat shimmer, and eyes glowing blood-bright. The menpō mask reads as a face in the dark.

## Composition

- One focal point per shot: the clash, the deathblow, or the title.
- The fighters stay in the middle or lower third. The moon and the keep stay in the upper third.
- The HUD stays thin, in a corner and quiet: brush strokes, small kanji, no boxes.

## Never

- **Neon or saturated** colors outside the four palette roles, and never rainbow particles.
- **A purple or magenta wash** over the world. Violet belongs only to the Cursed Blade.
- **Pure black or pure white areas.** That includes the moon blowing out to a white blob.
- **Flat 2D shapes standing in for 3D effects,** such as drawn rings, flat discs or glowing circles.
- **Two warm light sources fighting** in one shot. Only one effect gets to be the bright one at a time.
- **Fighters lit flat from the front,** or fighters darker than the background behind them.
- **Effects that linger at full brightness.** Bright is short and the afterglow is dim.
- **Glowing UI text, drop shadows, bevels, gradient buttons, or boxes with borders** in menus.
- **Generic fantasy VFX:** magic circles, runes, lens dirt, or stars on the camera.
- **Still frames.** Something always moves in the wind.
