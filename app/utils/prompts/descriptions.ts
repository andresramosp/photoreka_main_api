import Photo from '#models/photo'

export const MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY = (photosBatch: Photo[]) => `
 You are a bot in charge of analyzing photographs and returning diverse and structured information for each photo, from a 'street photography' point of view. 

 For each image, include following properties:
 
- 'context': mention the place where the scene takes place, the time of day, as well as the cultural context. 
   Also, when it becomes clear, add the country and/or city. Minimum 30 - 35 words. 
- 'story': Here focus on most relevant characters, rather than on the whole scene or the context, and describe what they are doing, 
   their gestures and interactions. Discard elements too distant or barely visible. Minimum 150 - 180 words. 

📌 **Output format:**  
json [
     { 'context': "...", 'story': "..."},
      ...
   ]

Always return a JSON array, each item containing information about one image, in the same order of the input images.
`

// TODO: 1) volver a intentar meter arriba con esta desc, 2) darle otra oportunidad a Molmo... con o sin pretrained, a max_crops 8 o 9
export const MESSAGE_ANALYZER_GPT_VISUAL_ACCENTS = (photosBatch: Photo[]) => `
 You are a chatbot tasked with adding visual information to photographs. For each of them, we've already extracted a list of prominent elements, 
 but now you must re-analyze the photo more carefully to detect others that may have gone unnoticed but add value to the scene/composition from a
 'street photography' point of view. 

 *Guidelines*
- Typically, you'll look for things like: 1) Drawings, signs, symbols whose content adds visual value. 2) Not obvious secondary characters but with some interest. 
  3) An object / dress carried by someone that adds a nuance. 4) Any subtle but relevant detail on the edges of the image or in the background.
- Be specific. Don't describe "a table with many items" but rather find a specific, interesting item and mention it.

Maximum number of elements per image is 5. 

For each image, return these properties:
- visual_accents: "element_1 | element_2 | element_2, ..."

📌 **Example:**

\`\`\`json
[
  {
    "visual_accents": "elderly man looking curiously from window | no entry red sign | advertisement with a sensual woman's face | funny jester's hat on a pedestrian's head",
  },
 {
    "visual_accents": "poster with a growling tiger drawing | signs on the wall, including a big blue circle | for sale sign on wooden door | part of hand with ice cream",
  },
]
\`\`\`

Always return a JSON array, each item containing information about one image, in the same order of the input images.
`

export const MESSAGE_ANALYZER_GPT_VISUAL_ACCENTS_PRETRAINED = (photosBatch: any[]) => `
 You are a chatbot tasked with adding visual information to photographs. For each of them, we've already extracted a list of prominent elements, 
 but now you must re-analyze the photo more carefully to detect others that may have gone unnoticed but add value to the scene/composition from a
 'street photography' point of view. 

 *Guidelines*
- Typically, you'll look for things like: 1) Drawings, signs, symbols whose content adds visual value. 2) Undetected secondary characters with some interest. 
  3) An object / dress carried by a character that adds a nuance. 4) Any subtle but relevant detail on the edges of the image or in the background.
- Be specific. Don't describe "a table with many items" but rather find a specific, interesting item and mention it.
- 📌 A crucial rule is that the elements you contribute must not already be present in the list of provided tags. If there is nothing to add, add nothing 📌

Maximum number of elements per image is 5. 

For each image, return:
- id: the unique ID of the image
- visual_accents: "element_1 | element_2 | element_2, ..."
- ...

📌 **Example:**

\`\`\`json
[
  {
    "id": 1,
    "visual_accents": "elderly man looking curiously from window | no entry red sign | advertisement with a sensual woman's face | funny jester's hat on a pedestrian's head",
  },
 {
    "id": 2,
    "visual_accents": "poster with a growling tiger drawing | signs on the wall, including a big blue circle | for sale sign on wooden door | part of hand with ice cream",
  },
]
\`\`\`

List of ordered images with tags already extracted: ${JSON.stringify(
  photosBatch.map((photo: Photo) => ({
    id: photo.id,
    tags: photo.tags
      .filter((t) => ['person', 'objects', 'animals', 'environment', 'symbols'].includes(t.group))
      .map((tag) => tag.name)
      .join(', '),
  })),
  null,
  2
)}

Always return a JSON array, each item containing information about one image.
`

// TODO: pruebas con un enrichment de Molmo?

export const MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED = (shortDesc: string) => `

We already know this image have this general context: ${shortDesc}.

But now provide an artistic evaluation of the image, from a critic point of view. Maximum 60 words. 

Follow these 4 instructions:  
1. Evaluate the photo from an aesthetic point of view.
2. Evaluate the photo from a compositional point of view: balance, layered structure, easy reading, etc. 
3. Evaluate the photo according to possible metaphoric echoes, figurative meanings, peculiar juxtapositions, if any.
4. If any, point out a notable aspect of this image that can TRULY amaze or impact the viewer eye 
 
Return only the description text, with no additional comments.  
`

export const MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED = (shortDesc: string) => `

We already know this image have this general context: '${shortDesc}'.

And now we need a topological description. For this purpose, divide the image into three areas (left, middle, right) and return a text with this format:

{ 
  "topology": 
    {
      "left_area_shows": ...,
      "middle_area_shows": ...,
      "right_area_shows": ...,
    }   
}

For each area, describe all the relevant elements that you see. 
Pay special attention to symbols, signs, and paintings, and describe their content.
Minimum 60 words. Maximum 90 words (depending on photo complexity)
 
Return only the text in the mentioned format, using english language, with no additional comments.  
`
