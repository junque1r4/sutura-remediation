# Sutura sandbox -- Java/JVM toolchain (Gradle + Maven on top of the base image).
# Used for findings in pom.xml / build.gradle projects so `gradle dependencies`
# and `mvn dependency:resolve` resolve instead of failing with "command not
# found". NOTE: plain JVM projects only -- Android projects additionally need the
# Android SDK/NDK (ANDROID_HOME), which is multi-GB and NOT installed here.
# The base image is passed explicitly (--build-arg BASE_IMAGE=...) and never
# defaults to a mutable :latest tag, so a build can't silently pull an
# unrelated public image. Local: the sutura/sandbox-base you just built;
# CI: the same-commit ACR tag.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# JDK 17 (headless) + Maven from Debian, plus unzip for the Gradle distribution.
# default-jdk-headless creates the arch-agnostic /usr/lib/jvm/default-java symlink.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      default-jdk-headless \
      maven \
      unzip \
 && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/default-java

# Gradle (Debian's package lags; install a current release). A repo that ships
# its own ./gradlew wrapper will use that instead; this is the fallback `gradle`.
ARG GRADLE_VERSION=8.10.2
RUN curl -fsSL -o /tmp/gradle.zip \
      "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
 && unzip -q /tmp/gradle.zip -d /opt \
 && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
 && rm /tmp/gradle.zip

WORKDIR /work
CMD ["sleep", "infinity"]
