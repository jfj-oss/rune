#!/bin/sh
# Regenerates the PWA PNG icons from public/icons/icon.svg (full-bleed square art with its own background).
# Needs ImageMagick. Replace icon.svg (and mark.svg for the sidebar), then run:  sh scripts/make-icons.sh
set -e
cd "$(dirname "$0")/../public/icons"
magick -background none icon.svg -resize 192x192 icon-192.png
magick -background none icon.svg -resize 512x512 icon-512.png
magick -background none icon.svg -resize 180x180 -background '#14131c' -flatten apple-touch-icon.png
# maskable: art shrunk to the 80% safe zone on a solid background
magick -background '#14131c' icon.svg -resize 410x410 -gravity center -extent 512x512 icon-maskable-512.png
