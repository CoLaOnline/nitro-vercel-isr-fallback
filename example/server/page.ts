export const paths = ["/", "/about", "/blog/first-post"];

export async function page(title: string) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  const links = paths.map((path) => `<a href="${path}">${path}</a>`).join(" ");
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <p>Rendered at ${new Date().toISOString()} after an 800 ms wait.</p>
    <nav>${links}</nav>
  </body>
</html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
