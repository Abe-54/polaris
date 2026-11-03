package dev.lux.polaris.sodium;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationTargetException;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.HexFormat;

// The host JVM has no Expo runtime. Only its exception base is replaced here.
class SodiumException extends RuntimeException {
  public SodiumException(String message) { super(message); }
}

public final class NativeProbe {
  public static void main(String[] args) throws Exception {
    BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
    String operation = reader.readLine();
    int count = Integer.parseInt(reader.readLine());
    ByteBuffer[] parents = new ByteBuffer[count];
    ByteBuffer[] groups = new ByteBuffer[count];
    HexFormat hex = HexFormat.of();
    for (int i = 0; i < count; i++) {
      byte[] bytes = hex.parseHex(reader.readLine());
      parents[i] = ByteBuffer.allocateDirect(bytes.length + 24);
      for (int j = 0; j < parents[i].capacity(); j++) parents[i].put(j, (byte) 0x5a);
      parents[i].position(11).limit(11 + bytes.length);
      groups[i] = parents[i].slice();
      groups[i].put(bytes).clear();
    }
    int argc = Integer.parseInt(reader.readLine());
    ByteBuffer[] buffers = new ByteBuffer[argc];
    Class<?>[] types = new Class<?>[argc];
    Arrays.fill(types, ByteBuffer.class);
    for (int i = 0; i < argc; i++) {
      String[] view = reader.readLine().split("\t");
      int offset = Integer.parseInt(view[1]);
      int length = Integer.parseInt(view[2]);
      buffers[i] = groups[Integer.parseInt(view[0])].slice(offset, length);
    }
    String status;
    try {
      Object result = Sodium.class.getDeclaredMethod(operation, types).invoke(null, (Object[]) buffers);
      status = "OK\t" + (result == null ? "" : result);
    } catch (InvocationTargetException error) {
      if (!(error.getCause() instanceof SodiumException)) throw error;
      status = "ERR\t" + error.getCause().getMessage();
    }
    System.out.println(status);
    for (int i = 0; i < count; i++) {
      parents[i].clear();
      for (int j = 0; j < parents[i].capacity(); j++) {
        if (j >= 11 && j < 11 + groups[i].capacity()) continue;
        if (parents[i].get(j) != (byte) 0x5a) throw new AssertionError("JNI wrote outside the buffer view");
      }
      byte[] bytes = new byte[groups[i].capacity()];
      groups[i].get(bytes);
      System.out.println(hex.formatHex(bytes));
    }
  }
}
