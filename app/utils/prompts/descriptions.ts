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
   
3. 'visual_accents': Here you must re-analyze the photo to detect others relevant elements that were not mentioned in the previous sections but add value to the image.
   Typically, you'll look for things like: Drawings, signs, symbols whose content adds visual value. Secondary characters with some interest. 
   An object / dress weared by someone that adds a nuance. Any relevant/strange detail on the scene.
   Be specific. Don't describe "a table with many items" but rather find a specific, interesting item and mention it. 

*General rules*
1. DON'T ADD elements distant or barely visible.
2. Include only items that you have a high degree of certainty about (+90%).
3. As a consequence of the previous rule, AVOID assumptions such as "He is holding something unclear that could be a cup"
   
Minimum lenghts for properties:
1. 'context': 25 - 30 words
2. 'story': 130 - 160 words
3. 'visual_accents': 5 - 6 elements, dot separated.

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

export const MESSAGE_ANALYZER_GPT_CONTEXT_TECHNICAL_TAGS = (photosBatch: Photo[]) => `
You are a bot specialized in analyzing photographs and extracting structured technical information from a 'street photography' point of view.

Your task is to examine each image and classify it according to the following technical criteria. For each criterion, always choose exactly one of the provided options — even if you're unsure, pick the most likely one.

This is not about artistic interpretation or story — focus only on the technical properties of the image such as color, sharpness, focal length feel, exposure, etc.

📌 Return a JSON array, one object per photo, in the same order as the input. Each object must contain these exact fields:

- "color": "color" / "black and white"
- "sharpness": "sharp" / "blurry"
- "lens_type": "wide-angle" / "normal" / "telephoto"
- "exposure": "well exposed" / "overexposed" / "underexposed"
- "orientation": "horizontal" / "vertical"
- "noise": true / false
- "bokeh": true / false
- "long_exposure": true / false

📎 General rules:
1. Do NOT explain or describe the image — just output the JSON.
2. Never add or remove fields.
3. Never include multiple values per field.
4. Do not guess or invent visual content. Choose the most likely technical reading.

📌 Output example:
\`\`\`json
[
  {
    "color": "color",
    "sharpness": "sharp",
    "lens_type": "normal",
    "exposure": "well exposed",
    "orientation": "horizontal",
    "noise": false,
    "bokeh": false,
    "long_exposure": false
  },
  ...
]
\`\`\`
`

export const MESSAGE_PHOTO_INSIGHTS = `You are an expert in photography, art, and history. Your task is to analyze an image and provide curious, interesting, and educational facts about it in a "Did you know...?" format.

Focus on:
- Technical elements of the photograph (composition, lighting, techniques)
- Historical or cultural context of what appears in the image
- Fun facts about objects, places, people, or visible elements
- Interesting artistic or aesthetic aspects
- Information that might surprise or educate the user

Return a JSON object with a single key "insights" containing an array of strings, each string being a fact or insight about the image.

Example 1:
{
  "insights": [
    "Did you notice how the unicorn on the girl's shirt echoes the white horse in the background? A playful detail you might not have noticed!",
    "Did you know that the type of natural lighting we see here is known as 'golden hour' and occurs during the first and last 60 minutes of sunlight?"
  ]
}

Example 2:
{
  "insights": [
    "Have you noticed that the three men in this image appear to form a watercolor of complementary colors?",
    "Did you know that the pizzeria sign says 'We want you' as a parody of the famous American sign?"
  ]
}

Provide 2-3 relevant and specific insights for the image. Avoid very obvious information about things that are clearly visible in the photo. like Maximum 40 words per insight.`
