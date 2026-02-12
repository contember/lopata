# Images binding

Image transformation and metadata binding.

## Wrangler config

```jsonc
"images": {
  "binding": "IMAGES"
}
```

## API to implement

### ImagesBinding

- `info(stream: ReadableStream): Promise<ImageInfo>` — get image dimensions, format, file size
- `input(stream: ReadableStream): ImageTransformer` — begin transformation pipeline

### ImageInfo

```ts
{
  width: number;
  height: number;
  format: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" | "image/svg+xml";
  fileSize: number;
}
```

### ImageTransformer

- `transform(options: ImageTransform): ImageTransformer` — chainable transforms
- `draw(image: ReadableStream, options?: DrawOptions): ImageTransformer` — composite overlay
- `output(options: OutputOptions): Promise<ImageOutputResult>` — finalize

### ImageTransform

Key options: `width`, `height`, `fit` ("contain"|"cover"|"crop"|"scale-down"|"pad"), `rotate` (0/90/180/270), `blur` (1-250), `brightness`, `contrast`, `sharpen`, `trim`, `flip`, `flop`, `background` (color)

### OutputOptions

- `format: "image/png" | "image/jpeg" | "image/webp" | "image/avif"`
- `quality?: number` (1-100)

## Implementation notes

- This is hard to fully implement without native image processing
- **Minimal viable approach**: passthrough — `input()` returns the stream unchanged, `info()` reads image headers for dimensions
- Could optionally use `sharp` (npm) if available, but keep it as a no-op stub by default
- `transform()` collects transform options, `output()` returns the original stream with correct content-type
- Log a warning that image transformations are not applied in dev mode
