# PWA Setup - Icon Generation Instructions

Your app now supports **Progressive Web App (PWA)** features, allowing users to add it to their Android home screen!

## Files Created

- **manifest.json** - PWA manifest with app metadata
- **icon.svg** - Money-themed icon (coins, dollar sign, growth arrow)
- **sw.js** - Service Worker for offline support and caching
- **index.html** - Updated with PWA meta tags

## Generate PNG Icons from SVG

To complete the setup, you need to convert the SVG icon to PNG formats. Here are the recommended sizes:

### Online Tools (Easiest)
1. Visit: https://cloudconvert.com/svg-to-png
2. Upload `icon.svg`
3. Convert to PNG and download:
   - `icon-192.png` (192x192px)
   - `icon-512.png` (512x512px)

### Alternative: Using ImageMagick (if installed)
```bash
convert -density 192 icon.svg -resize 192x192 icon-192.png
convert -density 512 icon.svg -resize 512x512 icon-512.png
```

### Alternative: Using Inkscape
```bash
inkscape icon.svg --export-png=icon-192.png -w 192 -h 192
inkscape icon.svg --export-png=icon-512.png -w 512 -h 512
```

## "Maskable" Icons (Optional but Recommended)

For better adaptive icon support on modern Android, create maskable versions:
- `icon-192-maskable.png` (same as icon-192.png)
- `icon-512-maskable.png` (same as icon-512.png)

You can also slightly adjust the design to be more centered for better masking.

## How to Add to Android Home Screen

Once PNG icons are in place:

1. Open the app in Chrome/Edge on Android
2. Tap the **menu** (⋮)
3. Select **"Install app"** or **"Add to Home screen"**
4. The app will appear as a standalone app icon

## Features Enabled

✅ Standalone app mode (no browser UI)
✅ Custom theme color (#2d5f4f - teal green)
✅ Offline support (Service Worker caching)
✅ Fast loading from cache
✅ App shortcuts (add transaction from home screen)
✅ iOS support (Apple mobile web app)

## Testing Locally

Install PNG icons in the root directory, then test with:
```bash
python -m http.server 8080
```

Open on Android and check the menu for install option!
