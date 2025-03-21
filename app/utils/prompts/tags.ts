import Photo from '#models/photo'
import { tagGroups } from '#models/tag'

export const MESSAGE_TAGS_TEXT_EXTRACTION = `
You are an chatbot designed to extract relevant tags from a photo description. 

*Guidelines*
  - Adjectivize tags whenever you can or add relevant nuances. For actions tags, always include the subject of the action. 
  - Disambiguates problematic terms. Example: orange (fruit), scooter (motorcycle)
  - For each tag, add the category after a pipe |. The categories are: ${tagGroups.join(', ')}. 
  - Dedicate at least one tag for the culture context/country, if mentioned, and for time of day/weather. 
  - Extract as many tags as needed to cover all the elements in the text.
  - Maximum words per tag is 5

📌 **Output example:**  
\`\`\`json
{
  'tags': ['man playing tennis | person', 
           'freedom | abstract concept',  
           'traditional building | environment', 
           'river | environment', 
           'Indian city' | toponym,
           'orange (fruit) | objects'
           'painting of tiger | symbols,
           'happy day | mood',
           ...], 
}
\`\`\`

**⚠ Return ONLY the JSON object containing an array inside 'tags' field, without any extra text.** 
`

export const MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS = (photosBatch: Photo[]) => `
You are a chatbot tasked with locating elements (tags) in photographs. For each image, you are given a list of tags, 
each with a unique ID and a descriptive name. Your task is to place each tag in one of three areas: 'left', 'middle', or 'right'. 
These areas are visually delimited in the image by vertical superimposed white lines.

For each image, return:
- id: the unique ID of the image
- tag_id_1: 'left' | 'middle' | 'right'
- tag_id_2: 'left' | 'middle' | 'right'
- ...

📌 **Example:**

\`\`\`json
[
  {
    "id": 1,
    "123": "left",
    "124": "middle",
    ...
  },
  {
    "id": 2,
    "125": "right",
    "126": "left",
    ...
  }
]
\`\`\`

List of ordered images with tags: ${JSON.stringify(
  photosBatch.map((photo: Photo) => ({
    id: photo.id,
    tags: photo.tags
      .filter((t) => ['person', 'objects', 'animals', 'environment', 'symbols'].includes(t.group))
      .map((tag) => ({ id: tag.id, name: tag.name })),
  })),
  null,
  2
)}

Always return a JSON array, each item containing information about one image. Do not include tag names in the output.
`
