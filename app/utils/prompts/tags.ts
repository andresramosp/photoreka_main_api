import Photo from '#models/photo'
import { tagGroups } from '#models/tag'
import TagPhoto from '#models/tag_photo'

export const MESSAGE_TAGS_TEXT_EXTRACTION = `
You are an chatbot designed to extract relevant tags from a photo description. 

*Guidelines*
  - Adjectivize tags whenever you can or add relevant nuances. 
  - If the text mentions people performing an action, keep the subject and verb together (girl exploring).
  - If the text describes someone, keep the subject and adjective together (happy girl).
  - Disambiguates problematic terms. Example: orange (fruit), scooter (motorcycle)
  - For each tag, add the category after a pipe |. The categories are: ${tagGroups.filter((tg) => tg != 'misc').join(', ')}. 
  - Dedicate at least one tag for the culture context/country, if mentioned, and for time of day/weather. 
  - Extract as many tags as needed to cover all the elements in the text literally, avoiding generalizations.
  - Maximum words per tag is 5

📌 **Example:**  

Input: ""A girl sits gazing at a tropical landscape. She seems somewhat thoughtful, perhaps a little sad. She has a friendly black cat by her side, which she is petting. It's afternoon, in an Asian city, probably in India, and the atmosphere is autumnal and relaxed"

Output \`\`\`json
{
  "tags": [
    "girl sitting | person",
    "girl gazing at landscape | person",
    "girl thoughtful | emotional state",
    "girl sad | emotional state",
    "girl petting cat | action",
    "friendly black cat | animal",
    "tropical landscape | environment",
    "Indian city | toponym",
    "autumnal relaxed atmosphere | ambiance",
    "afternoon | time of day"
  ]
}
\`\`\`

**⚠ Return ONLY the JSON object containing an array inside 'tags' field, without any extra text.** 
`

export const MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS = (photosBatch: Photo[]) => `
You are a chatbot tasked with locating elements (tags) in photographs. For each image, you are given a list of tags, 
each with a unique ID and a descriptive name. Your task is to place each tag in one of three areas of the image: 'left', 'middle', or 'right'. 

For each image, return:
- tag_id_1: 'left' | 'middle' | 'right'
- tag_id_2: 'left' | 'middle' | 'right'
- ...

📌 **Example:**

\`\`\`json
[
  {
    "123": "left",
    "124": "middle"
  },
  {
    "125": "right",
    "126": "left",
  }
]
\`\`\`

List of ordered images with tags: ${JSON.stringify(
  photosBatch.map((photo: Photo, index: number) => ({
    photoIndex: index,
    tags: photo.tags
      .filter((tagPhoto: TagPhoto) =>
        ['person', 'objects', 'animals', 'environment', 'symbols'].includes(tagPhoto.tag.group)
      )
      .map((tagPhoto: TagPhoto) => ({ id: tagPhoto.id, name: tagPhoto.tag.name })),
  })),
  null,
  2
)}

Always return a JSON array, each item containing information about one image, in the same order of the input images.
`
