/** Remove machine-local user and temporary roots from persisted evaluation evidence. */
export function redactEvaluationMachinePaths(value: string): string {
  return value
    .replace(/file:\/\/\/(?:Users|home)\/[^/\\\s"'`]+/giu, "file://<home>")
    .replace(/file:\/\/\/root(?=\/|$)/giu, "file://<home>")
    .replace(/file:\/\/\/(?:private\/tmp|tmp|var\/tmp)(?=\/|$)/giu, "file://<temporary>")
    .replace(
      /file:\/\/\/(?:private\/)?var\/folders\/[^/\\\s"'`]+\/[^/\\\s"'`]+\/[A-Z](?=\/|$)/giu,
      "file://<temporary>",
    )
    .replace(
      /(^|[^A-Za-z0-9:/])\/(?:Users|home)\/[^/\\\s"'`]+/gu,
      "$1<home>",
    )
    .replace(/(^|[^A-Za-z0-9:/])\/root(?=\/|$)/gu, "$1<home>")
    .replace(
      /(^|[^A-Za-z0-9:/])\/(?:private\/)?var\/folders\/[^/\\\s"'`]+\/[^/\\\s"'`]+\/[A-Z](?=\/|$)/gu,
      "$1<temporary>",
    )
    .replace(
      /(^|[^A-Za-z0-9:/])\/(?:private\/tmp|tmp|var\/tmp)(?=\/|$)/gu,
      "$1<temporary>",
    )
    .replace(
      /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+)/giu,
      "$1<home>",
    );
}
