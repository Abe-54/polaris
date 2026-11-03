# Use upstream's portable sources, without architecture-specific assembly or intrinsics.
set(sodium_root "${libsodium_SOURCE_DIR}/src/libsodium")
file(READ "${sodium_root}/Makefile.am" sodium_makefile)
string(FIND "${sodium_makefile}" "\nif HAVE_TI_MODE" portable_end)
if(portable_end EQUAL -1)
  message(FATAL_ERROR "The pinned libsodium portable source list is missing")
endif()
string(SUBSTRING "${sodium_makefile}" 0 ${portable_end} portable_makefile)
string(REGEX MATCHALL "[a-z0-9_/.-]+\\.c" sodium_sources "${portable_makefile}")
list(APPEND sodium_sources
  crypto_stream/salsa20/ref/salsa20_ref.c
  randombytes/sysrandom/randombytes_sysrandom.c
  randombytes/internal/randombytes_internal_random.c
)
list(TRANSFORM sodium_sources PREPEND "${sodium_root}/")

set(VERSION "1.0.21")
set(SODIUM_LIBRARY_VERSION_MAJOR 26)
set(SODIUM_LIBRARY_VERSION_MINOR 3)
set(SODIUM_LIBRARY_MINIMAL_DEF "#define SODIUM_LIBRARY_MINIMAL 1")
configure_file("${sodium_root}/include/sodium/version.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/include/sodium/version.h" @ONLY)

add_library(sodium STATIC ${sodium_sources})
set_target_properties(sodium PROPERTIES
  C_STANDARD 99 POSITION_INDEPENDENT_CODE ON C_VISIBILITY_PRESET hidden)
target_include_directories(sodium PUBLIC
  "${sodium_root}/include"
  "${CMAKE_CURRENT_BINARY_DIR}/include"
  "${sodium_root}/include/sodium"
  "${CMAKE_CURRENT_BINARY_DIR}/include/sodium")
target_compile_definitions(sodium PUBLIC SODIUM_STATIC PRIVATE CONFIGURED=1)

include(CheckCSourceCompiles)
check_c_source_compiles("int main(void) { unsigned __int128 n = 1; return (int)(n >> 64); }" HAVE_TI_MODE)
if(HAVE_TI_MODE)
  target_compile_definitions(sodium PRIVATE HAVE_TI_MODE=1)
endif()
include(TestBigEndian)
test_big_endian(sodium_big_endian)
if(sodium_big_endian)
  target_compile_definitions(sodium PRIVATE NATIVE_BIG_ENDIAN=1)
else()
  target_compile_definitions(sodium PRIVATE NATIVE_LITTLE_ENDIAN=1)
endif()

if(WIN32)
  target_link_libraries(sodium PRIVATE advapi32)
else()
  find_package(Threads REQUIRED)
  target_link_libraries(sodium PRIVATE Threads::Threads)
  target_compile_definitions(sodium PRIVATE HAVE_PTHREAD=1)
  include(CheckSymbolExists)
  check_symbol_exists(getpid "unistd.h" HAVE_GETPID)
  check_symbol_exists(sysconf "unistd.h" HAVE_SYSCONF)
  check_symbol_exists(mmap "sys/mman.h" HAVE_MMAP)
  check_symbol_exists(mlock "sys/mman.h" HAVE_MLOCK)
  check_symbol_exists(madvise "sys/mman.h" HAVE_MADVISE)
  check_symbol_exists(mprotect "sys/mman.h" HAVE_MPROTECT)
  check_symbol_exists(posix_memalign "stdlib.h" HAVE_POSIX_MEMALIGN)
  target_compile_definitions(sodium PRIVATE HAVE_SYS_MMAN_H=1)
  foreach(symbol GETPID SYSCONF MMAP MLOCK MADVISE MPROTECT POSIX_MEMALIGN)
    if(HAVE_${symbol})
      target_compile_definitions(sodium PRIVATE HAVE_${symbol}=1)
    endif()
  endforeach()
endif()
