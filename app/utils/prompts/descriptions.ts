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

export const MESSAGE_ANALYZER_GPT_CONTEXT_STORY_ACCENTS = (photosBatch: Photo[]) => `
 You are a bot in charge of analyzing photographs and returning diverse and structured information for each photo from a 'street photography' point of view. 

 For each image, include following properties:
 
1. 'context': mention the place where the scene takes place, the time of day, as well as the cultural context. When it becomes clear, add the country and/or city.

2. 'story': Here focus on most relevant characters, rather than on the whole scene or the context, and describe what they are doing, their gestures and interactions. 
   
3. 'visual_accents': Here you must re-analyze the photo to detect others elements that were not mentioned in the previous sections but add value to the image.
   Typically, you'll look for things like: Drawings, signs, symbols whose content adds visual value. Secondary characters with some interest. 
   An object / dress weared by someone that adds a nuance. Any relevant/strange detail on the edges of the image or in the background.
   Be specific. Don't describe "a table with many items" but rather find a specific, interesting item and mention it. 

*Guide lines for the 3 sections*
1. DISMISS elements too far or barely visible, especially those that require zoom to be detected.
2. Include only items that you have a high degree of certainty about (+90%).
3. As a consequence of the previous rule, AVOID assumptions such as "He is holding something unclear that could be a cup"
   
Minimum lenghts for properties:
1. 'context': 25 - 30 words
2. 'story': 130 - 160 words
3. 'visual_accents': 5 - 6 elements.

📌 **Output Example:**  
\`\`\`json
[
   { 
      'context': "This image features a bustling city...", 
      'story': "The main character is a woman standing...", 
      'visual_accents': "A poster with a red dragon drawing. Advertisement with a sensual woman's face. Hand sticking out with an ice cream"
   },
   ...
]
\`\`\`

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

// TODO: pruebas con un enrichment de Molmo?

export const MESSAGE_ANALYZER_MOLMO_VISUAL_ACCENTS = (photosBatch: Photo[]) => `
 You are a chatbot tasked with adding visual information to a photograph. We've already extracted a list of prominent elements for this one, 
 but now you must re-analyze the photo more carefully to detect others that may have gone unnoticed but add value to the scene/composition from a
 'street photography' point of view. 

 *Guidelines*
- Typically, you'll look for things like: 1) Drawings, signs, symbols whose content adds visual value. 2) Not obvious secondary characters but with some interest. 
  3) An object / dress carried by someone that adds a nuance. 4) Any subtle but relevant detail on the edges of the image or in the background.
- Be specific. Don't describe "a table with many items" but rather find a specific, interesting item and mention it.

Maximum number of elements per image is 5. 

Return only the text with the elements, with no additional comments
`

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
