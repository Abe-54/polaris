#!/bin/bash
set -u
label=$1; bin=$2; home=/tmp/g3pi/h-$label
rm -rf "$home"; mkdir -p "$home"
POLARIS_HOME="$home" "$bin" serve --foreground >"/tmp/g3pi/$label.log" 2>&1 &
pid=$!
for i in $(seq 1 100); do [ -S "$home/daemon.sock" ] && break; sleep 0.2; done
snap() { for t in /proc/$pid/task/*; do echo "$(basename $t) $(awk '/ctxt_switches/{s+=$2} END{print s}' $t/status)"; done | sort; }
sleep 30
snap > /tmp/g3pi/$label.s0; n0=$(wc -l < /tmp/g3pi/$label.s0)
sleep 60
snap > /tmp/g3pi/$label.s1; n1=$(wc -l < /tmp/g3pi/$label.s1)
kill $pid; wait $pid 2>/dev/null
d=$(join /tmp/g3pi/$label.s0 /tmp/g3pi/$label.s1 | awk '{s+=$3-$2} END{print s}')
echo "$label threads=$n0->$n1 ctx_per_s=$(awk -v c=$d 'BEGIN{printf "%.2f", c/60}')"
rm -rf "$home"
