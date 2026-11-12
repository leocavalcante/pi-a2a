/** Small valid ASCII PDF, generated locally without a model or external asset. */
export function syntheticPdf(
  text = "Synthetic PDF proof: APRICOT-783",
  pages = 1,
  options: { width?: number; encrypted?: boolean } = {},
): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: string[] = [];
  for (let index = 0; index < pages; index++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.width ?? 612} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
    );
    const stream = text
      ? `BT /F1 12 Tf 40 700 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`
      : "";
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>`;
  const encryption = options.encrypted
    ? objects.push(
        `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"00".repeat(32)}> /U <${"11".repeat(32)}> >>`,
      )
    : 0;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
      .join("");
  return Buffer.from(
    pdf +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption ? `/Encrypt ${encryption} 0 R /ID [<${"22".repeat(16)}> <${"22".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
