import Photo from '#models/photo'

export const MESSAGE_ANALYZER_VISUAL_ASPECTS = (photosBatch: Photo[]) => `
You are a bot in charge of analyzing photographs and returning structured information for each photo, focusing on technical-stylistic aspects. 

*Guidelines*

- For each image, extract a JSON object where each field is a technical-stylistic aspect, and the 
  value is one or more enumerated options that best describe the photo. 
- All the aspects must be an array of strings, even if it contains only one value


The aspects and possible values include:

1. 'focus': 'blurry', 'nitid'.
2. 'lighting_scheme': 'low key', 'high key', 'balanced'
3. 'stylistic': 'long exposure', 'motion blur', 'silhouettes', 'bokeh', 'grain'
4. 'lighting': 'natural', 'artificial', 'backlit', 'frontlit', 'side lit'
5. 'depth of field': 'shallow', 'deep', 'medium'
6. 'framing': 'close-up', 'medium shot', 'wide shot'.
7. 'genre': 'abstract', 'documentary', 'street', 'landscape', 'portrait'
8. 'perspective': 'normal', 'high angle', 'low angle', 

**Output Example for 1 image:**
\`\`\`json
[
  {
  "focus": ["nitid"],
  "stylistic": ["motion blur", "grain"],
  "lighting_scheme": ["low key"],
  "lighting": ["natural", "side lit"],
  "depth_of_field": ["deep"],
  "framing": ["close-up"],
  "genre": ["documentary", "street"],
  "perspective": ["normal"]
  }
]
\`\`\`

Always return a JSON array, each item containing the technical-stylistic aspects for one image, in the same order as the input images.
`
