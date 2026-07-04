// Official OLAG SHS (Our Lady of Grace Senior High School) logo, sourced from
// https://olagshs.edu.gh/our-logo/. `crestOnly` crops to just the shield emblem
// for compact/dark spots where the full text lockup wouldn't be legible.
export default function SchoolLogo({ height = 40, crestOnly = false, style }) {
  const src = `${process.env.PUBLIC_URL}/images/${crestOnly ? "olag-crest.png" : "olag-logo.png"}`;
  return (
    <img
      src={src}
      alt="Our Lady of Grace Senior High School"
      style={{ height, width: "auto", display: "block", ...style }}
    />
  );
}
