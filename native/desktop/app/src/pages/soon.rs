//! Pages that come in later phases (PORT-PLAN.md): the sidebar item is there, the page says so.
use crate::rune::*;
use crate::route::*;
use crate::theme::*;
use crate::widgets::*;
use gpui_kit::component::v_flex;
use gpui_kit::*;

impl Rune {
    pub fn soon_page(&mut self, r: Route, _cx: &mut Context<Self>) -> AnyElement {
        let phase = match r { Route::Home | Route::Tracks | Route::Genres => 2, Route::Discover | Route::Radio => 4, _ => 5 };
        v_flex().size_full().pt(px(28.)).px(px(PAD))
            .child(page_title(r.title()))
            .child(empty(&format!("{} is not in the desktop app yet", r.title()), &format!("It is planned for phase {phase} of native/desktop/PORT-PLAN.md. The web UI has it meanwhile.")))
            .into_any_element()
    }
}
