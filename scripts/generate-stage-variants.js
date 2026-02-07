#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')

let sharp
try {
  sharp = require('sharp')
} catch (error) {
  console.error('Missing dependency: sharp')
  console.error('Install it with: npm install -D sharp')
  process.exit(1)
}

const inputDir = path.resolve(__dirname, '../src/images/stages')
const outputDir = path.resolve(__dirname, '../src/images/stages/variants')

// Square sizes: 1^2..12^2 (1..144).
const sizeSteps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const sizes = sizeSteps.map((step) => step * step)

const allowedExts = new Set(['.jpg', '.jpeg', '.png'])

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

const listSourceFiles = () =>
  fs
    .readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => allowedExts.has(path.extname(name).toLowerCase()))

const writeResizedImage = async (inputPath, outputPath, size) => {
  const ext = path.extname(outputPath).toLowerCase()
  const pipeline = sharp(inputPath).resize(size, size, {
    fit: 'cover',
    position: 'centre',
  })
  if (ext === '.png') {
    await pipeline.png({ compressionLevel: 9 }).toFile(outputPath)
  } else {
    await pipeline.jpeg({ quality: 75 }).toFile(outputPath)
  }
}

const run = async () => {
  ensureDir(outputDir)
  const files = listSourceFiles()
  if (files.length === 0) {
    console.log(`No source images found in ${inputDir}`)
    return
  }

  let total = 0
  for (const file of files) {
    const inputPath = path.join(inputDir, file)
    const parsed = path.parse(file)
    for (const size of sizes) {
      const outputName = `${parsed.name}_${size}${parsed.ext}`
      const outputPath = path.join(outputDir, outputName)
      await writeResizedImage(inputPath, outputPath, size)
      total += 1
    }
  }

  console.log(`Generated ${total} images in ${outputDir}`)
}

run().catch((error) => {
  console.error('Stage variant generation failed:', error)
  process.exit(1)
})
