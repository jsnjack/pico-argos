// SPDX-License-Identifier: GPL-3.0-or-later

#define _GNU_SOURCE

#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "presentation-time-client-protocol.h"
#include "xdg-shell-client-protocol.h"

enum {
    SURFACE_WIDTH = 64,
    SURFACE_HEIGHT = 64,
    BUFFER_COUNT = 3,
};

struct app;

struct buffer {
    struct app *app;
    struct wl_buffer *proxy;
    uint32_t *pixels;
    bool busy;
};

struct app {
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct xdg_wm_base *wm_base;
    struct wp_presentation *presentation;
    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;
    struct buffer buffers[BUFFER_COUNT];
    uint32_t compositor_version;
    uint32_t presentation_clock_id;
    uint64_t submission;
    uint64_t started_ns;
    uint64_t duration_ns;
    bool configured;
    bool frame_ready;
    bool alternate;
};

struct feedback_state {
    uint64_t submission;
    uint64_t submitted_ns;
};

static volatile sig_atomic_t stopping;

static uint64_t
monotonic_ns(void)
{
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) {
        perror("clock_gettime");
        exit(EXIT_FAILURE);
    }
    return (uint64_t)value.tv_sec * 1000000000ull + (uint64_t)value.tv_nsec;
}

static void
on_signal(int signal_number)
{
    (void)signal_number;
    stopping = 1;
}

static void draw_frame(struct app *app);

static void
frame_done(void *data, struct wl_callback *callback, uint32_t callback_ms)
{
    struct app *app = data;
    wl_callback_destroy(callback);
    if (stopping || monotonic_ns() - app->started_ns >= app->duration_ns) {
        stopping = 1;
        return;
    }
    (void)callback_ms;
    app->frame_ready = true;
    draw_frame(app);
}

static const struct wl_callback_listener frame_listener = {
    .done = frame_done,
};

static void
feedback_sync_output(
    void *data,
    struct wp_presentation_feedback *feedback,
    struct wl_output *output)
{
    (void)data;
    (void)feedback;
    (void)output;
}

static void
feedback_presented(
    void *data,
    struct wp_presentation_feedback *feedback,
    uint32_t seconds_high,
    uint32_t seconds_low,
    uint32_t nanoseconds,
    uint32_t refresh_nanoseconds,
    uint32_t sequence_high,
    uint32_t sequence_low,
    uint32_t flags)
{
    struct feedback_state *state = data;
    uint64_t received_ns = monotonic_ns();
    uint64_t seconds = ((uint64_t)seconds_high << 32) | seconds_low;
    printf(
        "{\"type\":\"presented\",\"submission\":%llu,"
        "\"submittedMonotonicNanoseconds\":%llu,"
        "\"receivedMonotonicNanoseconds\":%llu,"
        "\"presentationSeconds\":%llu,\"presentationNanoseconds\":%u,"
        "\"refreshNanoseconds\":%u,\"sequenceHigh\":%u,"
        "\"sequenceLow\":%u,\"flags\":%u}\n",
        (unsigned long long)state->submission,
        (unsigned long long)state->submitted_ns,
        (unsigned long long)received_ns,
        (unsigned long long)seconds,
        nanoseconds,
        refresh_nanoseconds,
        sequence_high,
        sequence_low,
        flags);
    fflush(stdout);
    wp_presentation_feedback_destroy(feedback);
    free(state);
}

static void
feedback_discarded(void *data, struct wp_presentation_feedback *feedback)
{
    struct feedback_state *state = data;
    printf(
        "{\"type\":\"discarded\",\"submission\":%llu,"
        "\"submittedMonotonicNanoseconds\":%llu,"
        "\"receivedMonotonicNanoseconds\":%llu}\n",
        (unsigned long long)state->submission,
        (unsigned long long)state->submitted_ns,
        (unsigned long long)monotonic_ns());
    fflush(stdout);
    wp_presentation_feedback_destroy(feedback);
    free(state);
}

static const struct wp_presentation_feedback_listener feedback_listener = {
    .sync_output = feedback_sync_output,
    .presented = feedback_presented,
    .discarded = feedback_discarded,
};

static void
buffer_release(void *data, struct wl_buffer *proxy)
{
    struct buffer *buffer = data;
    (void)proxy;
    buffer->busy = false;
    if (buffer->app->frame_ready)
        draw_frame(buffer->app);
}

static const struct wl_buffer_listener buffer_listener = {
    .release = buffer_release,
};

static void
draw_frame(struct app *app)
{
    struct buffer *buffer = NULL;
    for (size_t index = 0; index < BUFFER_COUNT; index++) {
        if (!app->buffers[index].busy) {
            buffer = &app->buffers[index];
            break;
        }
    }
    if (buffer == NULL)
        return;

    app->frame_ready = false;
    app->alternate = !app->alternate;
    uint32_t color = app->alternate ? 0xff3584e4u : 0xff1c71d8u;
    for (size_t index = 0; index < SURFACE_WIDTH * SURFACE_HEIGHT; index++)
        buffer->pixels[index] = color;

    struct wl_callback *callback = wl_surface_frame(app->surface);
    wl_callback_add_listener(callback, &frame_listener, app);
    struct wp_presentation_feedback *feedback =
        wp_presentation_feedback(app->presentation, app->surface);
    struct feedback_state *state = calloc(1, sizeof(*state));
    if (state == NULL) {
        perror("calloc");
        exit(EXIT_FAILURE);
    }
    state->submission = ++app->submission;
    state->submitted_ns = monotonic_ns();
    wp_presentation_feedback_add_listener(feedback, &feedback_listener, state);
    buffer->busy = true;
    wl_surface_attach(app->surface, buffer->proxy, 0, 0);
    if (app->compositor_version >= WL_SURFACE_DAMAGE_BUFFER_SINCE_VERSION)
        wl_surface_damage_buffer(app->surface, 0, 0, SURFACE_WIDTH, SURFACE_HEIGHT);
    else
        wl_surface_damage(app->surface, 0, 0, SURFACE_WIDTH, SURFACE_HEIGHT);
    wl_surface_commit(app->surface);
}

static void
wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial)
{
    (void)data;
    xdg_wm_base_pong(wm_base, serial);
}

static const struct xdg_wm_base_listener wm_base_listener = {
    .ping = wm_base_ping,
};

static void
xdg_surface_configure(void *data, struct xdg_surface *surface, uint32_t serial)
{
    struct app *app = data;
    xdg_surface_ack_configure(surface, serial);
    if (!app->configured) {
        app->configured = true;
        app->started_ns = monotonic_ns();
        draw_frame(app);
    }
}

static const struct xdg_surface_listener xdg_surface_listener = {
    .configure = xdg_surface_configure,
};

static void
toplevel_configure(
    void *data,
    struct xdg_toplevel *toplevel,
    int32_t width,
    int32_t height,
    struct wl_array *states)
{
    (void)data;
    (void)toplevel;
    (void)width;
    (void)height;
    (void)states;
}

static void
toplevel_close(void *data, struct xdg_toplevel *toplevel)
{
    (void)data;
    (void)toplevel;
    stopping = 1;
}

static void
toplevel_configure_bounds(
    void *data,
    struct xdg_toplevel *toplevel,
    int32_t width,
    int32_t height)
{
    (void)data;
    (void)toplevel;
    (void)width;
    (void)height;
}

static void
toplevel_wm_capabilities(
    void *data,
    struct xdg_toplevel *toplevel,
    struct wl_array *capabilities)
{
    (void)data;
    (void)toplevel;
    (void)capabilities;
}

static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = toplevel_configure,
    .close = toplevel_close,
    .configure_bounds = toplevel_configure_bounds,
    .wm_capabilities = toplevel_wm_capabilities,
};

static void
presentation_clock_id(void *data, struct wp_presentation *presentation, uint32_t clock_id)
{
    struct app *app = data;
    (void)presentation;
    app->presentation_clock_id = clock_id;
    printf("{\"type\":\"environment\",\"presentationClockId\":%u}\n", clock_id);
    fflush(stdout);
}

static const struct wp_presentation_listener presentation_listener = {
    .clock_id = presentation_clock_id,
};

static void
registry_global(
    void *data,
    struct wl_registry *registry,
    uint32_t name,
    const char *interface,
    uint32_t version)
{
    struct app *app = data;
    if (strcmp(interface, wl_compositor_interface.name) == 0) {
        app->compositor_version = version < 4 ? version : 4;
        app->compositor = wl_registry_bind(
            registry, name, &wl_compositor_interface, app->compositor_version);
    } else if (strcmp(interface, wl_shm_interface.name) == 0) {
        app->shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
    } else if (strcmp(interface, xdg_wm_base_interface.name) == 0) {
        app->wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(app->wm_base, &wm_base_listener, app);
    } else if (strcmp(interface, wp_presentation_interface.name) == 0) {
        app->presentation = wl_registry_bind(
            registry, name, &wp_presentation_interface, 1);
        wp_presentation_add_listener(app->presentation, &presentation_listener, app);
    }
}

static void
registry_global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

static void
create_buffers(struct app *app)
{
    const size_t buffer_size = SURFACE_WIDTH * SURFACE_HEIGHT * sizeof(uint32_t);
    const size_t pool_size = buffer_size * BUFFER_COUNT;
    int descriptor = memfd_create("pico-argos-presentation", MFD_CLOEXEC);
    if (descriptor < 0 || ftruncate(descriptor, (off_t)pool_size) != 0) {
        perror("Creating shared buffer");
        exit(EXIT_FAILURE);
    }
    uint32_t *pixels = mmap(
        NULL, pool_size, PROT_READ | PROT_WRITE, MAP_SHARED, descriptor, 0);
    if (pixels == MAP_FAILED) {
        perror("mmap");
        exit(EXIT_FAILURE);
    }
    struct wl_shm_pool *pool = wl_shm_create_pool(
        app->shm, descriptor, (int32_t)pool_size);
    for (size_t index = 0; index < BUFFER_COUNT; index++) {
        struct buffer *buffer = &app->buffers[index];
        buffer->app = app;
        buffer->pixels = pixels + index * SURFACE_WIDTH * SURFACE_HEIGHT;
        buffer->proxy = wl_shm_pool_create_buffer(
            pool,
            (int32_t)(index * buffer_size),
            SURFACE_WIDTH,
            SURFACE_HEIGHT,
            SURFACE_WIDTH * (int32_t)sizeof(uint32_t),
            WL_SHM_FORMAT_ARGB8888);
        wl_buffer_add_listener(buffer->proxy, &buffer_listener, buffer);
    }
    wl_shm_pool_destroy(pool);
    close(descriptor);
}

static uint64_t
parse_duration(const char *value)
{
    char *end = NULL;
    errno = 0;
    unsigned long seconds = strtoul(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || seconds < 1 || seconds > 86400) {
        fprintf(stderr, "Duration must be from 1 through 86400 seconds\n");
        exit(EXIT_FAILURE);
    }
    return (uint64_t)seconds * 1000000000ull;
}

int
main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "Usage: %s DURATION_SECONDS\n", argv[0]);
        return EXIT_FAILURE;
    }
    struct sigaction action = {.sa_handler = on_signal};
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);

    struct app app = {
        .duration_ns = parse_duration(argv[1]),
    };
    app.display = wl_display_connect(NULL);
    if (app.display == NULL) {
        fprintf(stderr, "Connecting to the Wayland display failed\n");
        return EXIT_FAILURE;
    }
    struct wl_registry *registry = wl_display_get_registry(app.display);
    wl_registry_add_listener(registry, &registry_listener, &app);
    wl_display_roundtrip(app.display);
    wl_display_roundtrip(app.display);
    if (app.compositor == NULL || app.shm == NULL || app.wm_base == NULL ||
        app.presentation == NULL) {
        fprintf(stderr, "Required Wayland globals are unavailable\n");
        return EXIT_FAILURE;
    }

    create_buffers(&app);
    app.surface = wl_compositor_create_surface(app.compositor);
    app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.surface);
    xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
    app.toplevel = xdg_surface_get_toplevel(app.xdg_surface);
    xdg_toplevel_add_listener(app.toplevel, &toplevel_listener, &app);
    xdg_toplevel_set_title(app.toplevel, "pico-argos presentation timing");
    xdg_toplevel_set_app_id(app.toplevel, "io.github.jsnjack.pico-argos-timing");
    wl_surface_commit(app.surface);

    while (!stopping && wl_display_dispatch(app.display) != -1)
        ;

    xdg_toplevel_destroy(app.toplevel);
    xdg_surface_destroy(app.xdg_surface);
    wl_surface_destroy(app.surface);
    for (size_t index = 0; index < BUFFER_COUNT; index++)
        wl_buffer_destroy(app.buffers[index].proxy);
    wp_presentation_destroy(app.presentation);
    xdg_wm_base_destroy(app.wm_base);
    wl_shm_destroy(app.shm);
    wl_compositor_destroy(app.compositor);
    wl_registry_destroy(registry);
    wl_display_disconnect(app.display);
    munmap(
        app.buffers[0].pixels,
        BUFFER_COUNT * SURFACE_WIDTH * SURFACE_HEIGHT * sizeof(uint32_t));
    return EXIT_SUCCESS;
}
