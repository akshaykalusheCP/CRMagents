#!/bin/sh
# Contact sheet of stills: ./sheet.sh out.jpg t1 t2 ... (nine times)
out=$1; shift; args=""; i=0
for t in "$@"; do f=$(printf "stills/t%05.1f.jpg" "$t"); args="$args -i $f"; done
ffmpeg -loglevel error -y $args -filter_complex "[0][1][2]hstack=3[a];[3][4][5]hstack=3[b];[6][7][8]hstack=3[c];[a][b][c]vstack=3,scale=2400:-1" "$out"
