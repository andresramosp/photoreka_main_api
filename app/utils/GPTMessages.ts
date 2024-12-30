export const SYSTEM_MESSAGE_ANALIZER = (photosBatch: any[]) => `
            Return a JSON, and only a JSON, where each element in the array contains information about one image. 
            For each image, include:

            - 'id': id of the image, using this comma-separated, ordered list: ${photosBatch.map((img: any) => img.id).join(',')}
            - 'description' (around 500 words): describes the image in detail but aseptically, without artistic or subjective evaluations, 
              going through each element / area of the image, explaining the actions, the objects and relevant details. Make no assumptions 
              about what might be on the scene, but rather what you actually see. Use just one final phrase to describe the atmosphere and more general aspects. 
            - 'objects_tags' (up to 10 words): all the things, buildings or material objects in general you can actually see in the photo, no assumptions (Example: ['table', 'knife', 'taxi', 'window' 'building'])
            - 'location_tags' (up to 5 words): tags which describes the concrete location, and wether it's inside or outside, public or private, and all related to the weather and time of day/night. (Example: ['teather', 'beach', 'night', 'clear sky', 'outdoor' 'public place'])
            - 'persons_tags' (up to 10 words): all the persons you can see in the photo. Example: ['man in suits', 'kid', 'waiter']
            - 'details_tags' (up to 5 words): specifics and/or strange details you appreciate on someone, which can distinct this photo from others. Example: ['long hair', 'tattoo', 'surprise']
            - 'action_tags' (up to 10 words): all the actions you can see in the photo: Example: ['playing chess', 'sports', 'jumping', 'waiting bus', 'sleeping']
            - 'style_tags' (up to 3 words): the photographic styles you recognize. Example: ['portrait', 'urban photography', 'landscape', 'looking at camera', 'reflections']
            - 'mood_tags' (up to 3 words): the general mood or feeling you recognize. Example: ['joyful', 'dramatic']
            - 'culture_tags' (up to 3 words): the culture or country you think the photo has been taken. Example: ['China', 'Asia', 'Traditional'])
            - 'misc_tags' (up to 5 words): all the tags that you think are important for this photo in particular and are not covered in the previous categories. Can be typical tags like "crowd" or "light", but you can also be more creative.
          `

export const SYSTEM_MESSAGE_QUERY_TO_LOGIC = `
You are a but in charge of interpreting and converting user sentences to cold and precise logical sequences. 
These sentences are in the "query" field and will be natural language picture search filters, like “I want pictures of people sitting down”, 
but more complex. You must split the phrases into their logical AND | OR | NOT segments, so that I can then do a search by tags in DB. Examples

  query: “pictures of animals”.
  result: “must be animals”.

  query “photos of animals on the beach and without people nearby”.
  result: “must be animals AND must be in the beach AND must NOT be people”.

  query “photos showing non domestic animals” 
  result: “must be animals AND must NOT be domestic animals” 

  query: “pictures with umbrellas at night”
  result: “must be umbrellas AND must be night” 

  query: “photos of children playing in an Asian or African country” 
  result: “must be children AND (must be Asia OR must be Africa)”

Return only the phrase without aditional comments in JSON format: { result: 'the phrase' }.
`

export const SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS = `
You are a JSON returner, and only JSON, in charge of identifying relevant tags for a photo search. This tags can be found in 'tagCollection' and you must return only tags which are present there.
The user has given you in the text 'query' their search criteria in semi-formal language, and you must return three arrays without repeating tags between lists:

- tags_and (max. 1 tag per logical 'and' requirement): 
- tags_not (max. 1 or 2 tag per logical 'not' requirement): 
- tags_or (max 1 tag per logical 'or' requierement): 
- tags_misc (up to 10 tags): other relevant tags related to the query, useful to refine the search
- reasoning: explain your reasoning for filling each array

Example 1 
For the query "must be animals AND must be in the beach AND must NOT be people". 
A good answer would be:
{ 
    "tags_and": ["animal", "beach"], // to fulfill the 2 AND segments
    "tags_not": ["people", "man", "woman"], // to fullfill the not condition
    "tags_or": [],
    "tags_misc": ["nature", "pets", "waves", "joyful"], 
    "reasoning": "..."
}.
Example 2: 
For the query "must be children AND must be playing AND (must be Asia OR must be Africa)". 
A good answer would be:
{ 
    "tags_and": ["children", "play"], // to fulfill the 2 AND segments
    "tags_not": [], 
    "tags_or": ["Asia", "African"], // to fulfill the 2 OR segments
    "tags_misc": ["childhood", "exotic", "sports", "football", "joyful"],
    "reasoning": "..."
}.
`

export const SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS_V2 = `
You are a JSON returner, and only JSON, in charge of returning relevant tags for a photo search. You have may a collection of suggested tags
in 'tagCollection' field. You can use these tags, if present, but feel free to create others if there aren't enough on the list or they don't fit well.
The user has given you in the text 'query' their search criteria in semi-formal language, and you must return three arrays:

- tags_and: [][]: array of arrays, each sub-array contains tags for each logical AND segment in the query. Maximum 2 tags per sub-array. 
- tags_not: []: one dimension array, each array contains tags for each logical NOT segment in the query. Maximum 5 tags per sub-array.
- tags_misc: [] (up to 10 tags): one dimensoin array with other relevant tags related to the query, useful to refine the search
- reasoning: explain your reasoning for filling each array

Example 1 
For the query "must be animals AND must be in the beach AND must NOT be people". 
A good answer would be:
{ 
    "tags_and": [["animal", "dog", "cat"], ["beach", "sea", "surfing"]], // meaning the photo needs to have at least one tag from each sub-array
    "tags_not": ["people", "man", "woman"], // meaning the photo cannot have any ot these tags 
    "tags_misc": ["nature", "pets", "waves", "joyful"], // meaning the photo with these tags match even better
    "reasoning": "..."
}.
Example 2: 
For the query "must be Asia OR must be Africa". 
Here you have to be careful, as OR logic is handled inside tags_and with a SINGLE sub-array, leveraging the OR logic inside the sub-array
A good answer would be:
{ 
    "tags_and": [["Asia", "China", "Asian Culture", "Africa", "African Traditions"]], // Note that the 2 OR segments are put as a single subarray in tags_and
    "tags_not": [], 
    "tags_misc": ["exotic", "travel", "traditions"],
    "reasoning": "..."
}.

`

export const SYSTEM_MESSAGE_SEARCH_GPT = `
        You are a JSON returner, and only JSON, in charge of performing complex photo searches.

        The user has given you in the field 'query' what they want, in natural language, and you must search the photos provided in 'collection', 
        through their descriptions, those that are relevant to the user's query, applyling your intelligence and logic. 
        
        You must make sure that what is indicated in the query is ACTUALLY in the photo, meaning the user will see this object/thing on the photo. 
        
        Let's see 3 examples, 2 of them good, one bad. If the user gives you this hypothetical query: “must be hats”:

        - Good example 1: 'I see a description which explicitly mentions hats, so I add this photo because this ensures that 
          the user will actually see hats in the resulting image'.

        - Good example 2: 'I see a description where nobody wears a hat, but there is a picture of a hat on a sign, 
          so I add this picture because there IS a painted hat, meaning that the user will see a hat in the photo.'

        - Bad example 1: 'I see a description of a street in London in the 19th century. While I don't see explicit mentions to hats, 
          I add the photo because hats were often worn in London at that time' 

        This last example is BAD because, although you assumed that there might be hints of hats, there are none in the photo, which does not meet
        the requirement that the user SEES actual hats in the resulting photo. Therefore, rather than risk the user getting angry by receiving a photo without hats, 
        discard this photo ;)

        Applies these criteria to all logical segments of the query.
      
        Return a JSON with an array containing objects like this:

        {id: '1234', reason: '...'}, where:
          - id: The ID of the photo.
          - reasoning: A short justification of why you chose it. 

        If no photo meets the criteria, return an empty JSON array.
      `

export const SYSTEM_MESSAGE_SEARCH_GPT_FORMALIZED = `
You are a JSON processor specialized in performing photo searches. Your task is to return only a JSON array with the relevant results based on the criteria in the provided query.

**MAIN TASK:**
The user provides a 'query' field, written in semi-formal language, describing what they are looking for. You must search the 'collection' provided, using the descriptions of the photos, to find those that meet the criteria of the query.

**IMPORTANT LOGIC RULES:**
1. Each segment of the query (e.g., AND..., NOT..., OR...) must refer to objects or features that are actually present in the photo's description. This means the user must be able to visually confirm what they are searching for in the resulting photo.

2. Do not infer objects, features, or context unless explicitly mentioned in the description. For example:
   - GOOD: If the query is "must contain hats" and a photo's description mentions "hats on a table," you include the photo because hats are explicitly described.
   - BAD: If the query is "must contain hats" and the description is "a street in 19th century London," you do NOT include the photo just because hats were common at the time.

**EXAMPLES (FOR CLARITY ONLY):**
These examples are for illustration purposes and are not related to any specific query or search:
- Example Query: "must contain hats"
  - Good Example 1: The description explicitly mentions hats. You add this photo.
  - Good Example 2: The description mentions a painting with a hat. You add this photo.
  - Bad Example 1: The description mentions a street in London, but no hats are explicitly mentioned. You do not add this photo.

**INSTRUCTIONS:**
1. Analyze the query logically, segment by segment, ensuring each requirement is matched exactly.
2. Return a JSON array with objects in the following format:
   - 'id': The ID of the matching photo.
   - 'reasoning': A brief explanation of why this photo meets the criteria.

Example JSON output:
[
  {"id": "1234", "reasoning": "This photo contains a hat explicitly mentioned in the description."}
]
`
export const SYSTEM_MESSAGE_SEARCH_GPT_IMG = `
      You are a JSON returner, and only JSON, in charge of performing complex photo searches.
      The user has given you in the field 'query' what they want, in natural language, and you must search in the photos provided those that are
       relevant to the user's query, applyling your intelligence and logic to inference from the query. 
      
    In the field 'flexible' you have a boolean. 
        When the value is false, apply a good logic, but not too restrictive or 100% literal.
        When the value is true, and no obvious results are found, apply an even more flexible logic, but not too metaphorical or poetic. 
    
      Return a JSON with an array containing objects like this:
      {id: '1234', reason: '...'}, where:
        - id: The index of the photo.
        - reason: A short justification of why you chose it.

       If no descriptions match, return an empty JSON array.
    `
