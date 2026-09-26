// SQL files are imported as text (`import sql from "./x.sql" with { type: "text" }`).
declare module "*.sql" {
  const content: string;
  export default content;
}

// Default data files are embedded as text (`import ini from "./x.ini" with { type: "text" }`).
declare module "*.ini" {
  const content: string;
  export default content;
}
