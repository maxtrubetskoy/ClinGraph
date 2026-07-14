const mapConcurrent = async (items, limit, fn) => {
  const results = [];
  const executing = [];
  
  for (let i = 0; i < items.length; i++) {
    const p = (async () => {
      const res = await fn(items[i], i);
      return res;
    })();
    results.push(p);
    
    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
};

mapConcurrent([1, 2, 3, 4, 5], 2, async (x) => {
  console.log('start', x);
  await new Promise(r => setTimeout(r, 100));
  console.log('end', x);
  return x;
}).then(console.log);
