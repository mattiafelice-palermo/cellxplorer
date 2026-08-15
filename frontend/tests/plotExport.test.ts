import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDelimitedText,
  tracesToColumns,
} from "../src/features/analyses/editor/plotting/plotExport.ts";

test("CSV text starts with a UTF-8 BOM, not visible mojibake", () => {
  const text = buildDelimitedText(
    [{ header: "Voltage (V)", values: [3.1415926] }],
    "standard",
    "point",
    "comma",
  );

  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(
    [...new TextEncoder().encode(text).slice(0, 3)],
    [0xef, 0xbb, 0xbf],
  );
  assert.equal(text.startsWith("ï»¿"), false);
  assert.equal(text.slice(1), "Voltage (V)\r\n3.14159");
});

test("scientific export keeps raw semantic axis labels after Plotly escaping", () => {
  const columns = tracesToColumns(
    [
      {
        x: [1],
        y: [3.5],
        name: "Cell A",
        cellxplorer_export_axis_labels: { y: "Working potential vs R&D %{y}<br> (V)" },
      } as any,
    ],
    {
      xaxis: { title: { text: "Time (min)" } },
      yaxis: { title: { text: "Working potential vs R&amp;D &#37;{y}&lt;br&gt; (V)" } },
    },
  );

  assert.equal(columns[0].header, "Cell A | Time (min)");
  assert.equal(columns[1].header, "Cell A | Working potential vs R&D %{y}<br> (V)");
});
