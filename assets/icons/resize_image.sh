#!/bin/bash

# script to take one png and convert it to multiple sizes

# Check if the input file is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <input_file>"
  exit 1
fi

input_file=$1

# List of sizes
sizes=(16 24 32 48 64 96 128 256 512 1024)

# Get the filename without extension
filename=$(basename -- "$input_file")
extension="${filename##*.}"
filename="${filename%.*}"

# Loop through each size and create resized images
for size in "${sizes[@]}"; do
  output_file="${filename}_${size}x${size}.${extension}"
  ffmpeg -i "$input_file" -vf "scale=${size}:${size}" "$output_file"
  echo "Created ${output_file}"
done