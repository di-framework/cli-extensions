class Bucket {
  constructor(name) {
    this._name = name;
  }
  name() {
    return this._name;
  }
}

export const compute = {
  Bucket,
  open(name) {
    return new Bucket(name);
  },
  async echo(_bucket, input) {
    return (async function* () {
      for await (const chunk of input) yield chunk;
    })();
  },
  wait() {
    return Promise.resolve('ok');
  },
  async cancel(_bucket) {},
};
