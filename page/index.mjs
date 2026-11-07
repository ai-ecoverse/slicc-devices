export const kinds = {};

export function create() {
  async function handle({ kind }) {
    throw new DOMException(`slicc-devices does not answer ${kind}`, 'NotSupportedError');
  }

  return { kinds, handle };
}

const page = create();

export const handle = page.handle;

export default page;
