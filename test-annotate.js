fetch("http://localhost:3000/api/annotate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transcript: "Doctor: Hi, how are you?\nPatient: I have a headache." })
}).then(async r => {
  console.log(r.status);
  console.log(await r.text());
}).catch(console.error);
