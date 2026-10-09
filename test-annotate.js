async function stage(endpoint, input) {
  const response = await fetch(`http://localhost:3000/api/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || `HTTP ${response.status}`);
  console.log(endpoint, result);
  return result.data;
}

try {
  const extraction = await stage('extract-mentions', { transcript: 'Doctor: Hi, how are you?\nPatient: I have a headache.' });
  await stage('map-entities', { mentions: extraction.mentions, transcriptSegments: extraction.transcriptSegments });
} catch (error) { console.error(error); }
