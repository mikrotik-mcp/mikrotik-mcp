import { source } from "@root/lib/source";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@root/mdx-components";
import type { Metadata } from "next";
import { version } from "../../../../package.json";
import Link from "next/link";
import { siteMetadata } from "@root/lib/metadata";

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);

  if (!page) {
    notFound();
  }

  const MDX = page.data.body;
  const directory =
    params.slug?.length === 1
      ? source
          .getPages()
          .filter((entry) => entry.slugs.length === 2 && entry.slugs[0] === params.slug?.[0])
      : [];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <header className="article-header">
        <div className="article-kicker">
          <p className="eyebrow">
            {params.slug?.[0] === "reference"
              ? "REFERENCE"
              : params.slug?.[0] === "guides"
                ? "OPERATIONS GUIDE"
                : params.slug?.[0] === "dashboard"
                  ? "DASHBOARD GUIDE"
                  : "FIELD GUIDE"}
          </p>
          <span className="version-tag">v{version}</span>
        </div>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
      </header>
      <DocsBody className="article-content">
        <MDX components={getMDXComponents()} />
      </DocsBody>
      {directory.length > 0 && (
        <nav className="docs-directory" aria-label={`${page.data.title} pages`}>
          {directory.map((entry) => (
            <Link className="directory-card" key={entry.url} href={entry.url}>
              <div>
                <strong>{entry.data.title}</strong>
                <p>{entry.data.description}</p>
              </div>
              <span aria-hidden="true">↗</span>
            </Link>
          ))}
        </nav>
      )}
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      ...siteMetadata.openGraph,
      title: page.data.title,
      description: page.data.description,
    },
    twitter: {
      ...siteMetadata.twitter,
      title: page.data.title,
      description: page.data.description,
    },
  } satisfies Metadata;
}
