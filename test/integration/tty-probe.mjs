const encoder = new TextEncoder();

async function stat(ctx, path, link) {
  const info = await ctx.fs.stat(path);
  return {
    mode: info.mode.toString(8),
    uid: info.uid,
    gid: info.gid,
    link: await ctx.fs.readlink(link),
  };
}

async function modem(ctx, path, mode) {
  const file = await ctx.open(path, { read: true, write: mode !== 'ro' });
  try {
    if (mode === 'ro') {
      const first = await file.modem();
      const refused = await file.setModem({ dtr: false }).then(
        () => null,
        (error) => error.code
      );
      return { first, refused };
    }
    const first = await file.modem();
    await file.setModem({ dtr: false });
    await file.setModem({ rts: false });
    await file.setModem({ dtr: true });
    return { first, last: await file.modem() };
  } finally {
    await file.close();
  }
}

async function read(ctx, path, count) {
  const file = await ctx.open(path, { read: true });
  const parts = [];
  try {
    let size = 0;
    while (size < Number(count)) {
      const chunk = await file.read(0, Number(count) - size);
      if (!chunk.length) break;
      parts.push(...chunk);
      size += chunk.length;
    }
  } finally {
    await file.close();
  }
  return new TextDecoder().decode(Uint8Array.from(parts));
}

const actions = { stat, modem, read };

export default async function probe(ctx) {
  const [, action, ...args] = ctx.argv;
  const out = await actions[action](ctx, ...args);
  await ctx.write(1, encoder.encode(`${JSON.stringify(out)}\n`));
  return 0;
}
