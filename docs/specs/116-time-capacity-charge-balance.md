# 116. Time/Capacity charge balance and estimated SOC

In an incompletely recharged zinc–air Cell, the next discharge can deliver its usual
capacity while the inventory of metallic zinc falls. The plot follows recorded terminal
charge through the experiment and lets a scientist compare the deficit with voltage cutoffs.

## Measurement

Start each Cell at zero mAh at its first recorded sample. Accumulate the measured spans
of its canonical executed-step counters in acquisition order. Charge increases the
balance, discharge decreases it and verified rests hold it. Include incomplete halves
and carry the observed endpoint into the next ordered source. Break the drawn line at
source joins and excluded intervals. Unresolved transfer prevents a continuous inventory
estimate beyond that interval. Charge flowing while the instrument is stopped is unknown.

The horizontal axis shows test time or total recorded charge throughput in mAh. Throughput
adds the magnitudes in both directions. Cycle and protocol selection control which rows
are shown. The balance at those rows always includes the preceding measured history.

## Calibration and display

Offer charge balance in mAh immediately. Estimated SOC requires a starting SOC at the
first recorded sample and a positive reference for each Cell. Scientists can enter measured
usable capacity in mAh, or initial active mass in mg and specific capacity in mAh/g.
For zinc metal the two-electron Zn/Zn(II) reaction gives approximately 820 mAh/g.
The material-specific number is editable.

Estimated SOC equals starting SOC plus 100 times balance divided by reference capacity.
Show values outside 0–100%. The model assumes recorded charge goes into or comes from
the inventory. Corrosion, parasitic reactions and changes in accessible capacity can
affect that interpretation. A voltage cutoff alone does not establish an empty or full
electrode. Keep the aligned voltage accessible in hover and as an optional overlay.

Save the choice, inputs and target Cell with the plot. Preserve its axes, discontinuities
and calibration in scientific exports and remap Cell references when importing a portable report.
