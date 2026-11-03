cmake_minimum_required(VERSION 3.22.1)
project(polaris_sodium C)

include(FetchContent)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
endif()
FetchContent_Declare(libsodium
  URL "https://download.libsodium.org/libsodium/releases/libsodium-1.0.21.tar.gz"
  URL_HASH SHA256=9e4285c7a419e82dedb0be63a72eea357d6943bc3e28e6735bf600dd4883feaf
)
FetchContent_MakeAvailable(libsodium)

include(sodium.cmake)
add_library(polaris_sodium SHARED src/main/cpp/sodium_jni.c)
target_link_libraries(polaris_sodium PRIVATE sodium)
set_target_properties(polaris_sodium PROPERTIES C_STANDARD 99 C_VISIBILITY_PRESET hidden)

if(ANDROID)
  target_link_options(polaris_sodium PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,--no-undefined")
else()
  find_package(JNI REQUIRED)
  target_include_directories(polaris_sodium PRIVATE ${JNI_INCLUDE_DIRS})
  if(WIN32)
    set_target_properties(polaris_sodium PROPERTIES PREFIX "")
  endif()
endif()
