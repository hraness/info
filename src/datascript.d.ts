declare module "datascript" {
  type DataScript = {
    q(query: string, ...sources: readonly unknown[]): unknown;
  };

  const datascript: DataScript;
  export default datascript;
}
