// Standalone error page. The server sends it with status 404 for unknown
// URLs; ?status=&detail= let a link show any other error the same way.

import { queryParam } from "../dom.js";
import { renderError } from "../error-view.js";

renderError(
  document.getElementById("main"),
  Number(queryParam("status")) || 404,
  queryParam("detail") || "Not Found",
);
