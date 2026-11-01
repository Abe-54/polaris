#!/bin/bash
# Runs on the Pi. Usage: pi-idle.sh <label> <binary>. A throwaway Daemon under /tmp; idle samples from /proc.
set -u
label=$1; bin=$2
home=/tmp/g3pi/h-$label
rm -rf "$home"; mkdir -p "$home"
POLARIS_HOME="$home" "$bin" serve --foreground >"/tmp/g3pi/$label.log" 2>&1 &
pid=$!
for i in $(seq 1 100); do [ -S "$home/daemon.sock" ] && break; sleep 0.2; done
[ -S "$home/daemon.sock" ] || { echo "$label: no socket"; kill $pid; exit 1; }
sample() {
  local rss ticks ctx
  rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status)
  ticks=$(awk '{print $14+$15}' /proc/$pid/stat)
  ctx=$(cat /proc/$pid/task/*/status | awk '/ctxt_switches/{s+=$2} END{print s}')
  echo "$rss $ticks $ctx"
}
sleep 30
read r0 t0 c0 < <(sample)
sleep 60
read r1 t1 c1 < <(sample)
kill $pid; wait $pid 2>/dev/null
echo "$label rss_kib=$r1 rss_settled_kib=$r0 cpu_pct=$(awk -v t=$((t1-t0)) 'BEGIN{printf "%.3f", t/60}') ctx_per_s=$(awk -v c=$((c1-c0)) 'BEGIN{printf "%.2f", c/60}')"
rm -rf "$home"
