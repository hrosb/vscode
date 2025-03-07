/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/tunnelView';
import * as nls from 'vs/nls';
import * as dom from 'vs/base/browser/dom';
import { IViewDescriptor, IEditableData } from 'vs/workbench/common/views';
import { WorkbenchAsyncDataTree, TreeResourceNavigator2 } from 'vs/platform/list/browser/listService';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService, IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IContextKeyService, IContextKey, RawContextKey, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { ICommandService, ICommandHandler, CommandsRegistry } from 'vs/platform/commands/common/commands';
import { Event, Emitter } from 'vs/base/common/event';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ITreeRenderer, ITreeNode, IAsyncDataSource, ITreeContextMenuEvent } from 'vs/base/browser/ui/tree/tree';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { Disposable, IDisposable, toDisposable, MutableDisposable, dispose } from 'vs/base/common/lifecycle';
import { ActionBar, ActionViewItem, IActionViewItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { IconLabel } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { ActionRunner, IAction } from 'vs/base/common/actions';
import { IMenuService, MenuId, IMenu, MenuRegistry, MenuItemAction } from 'vs/platform/actions/common/actions';
import { createAndFillInContextMenuActions, createAndFillInActionBarActions, ContextAwareMenuEntryActionViewItem } from 'vs/platform/actions/browser/menuEntryActionViewItem';
import { IRemoteExplorerService, TunnelModel } from 'vs/workbench/services/remote/common/remoteExplorerService';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { InputBox, MessageType } from 'vs/base/browser/ui/inputbox/inputBox';
import { attachInputBoxStyler } from 'vs/platform/theme/common/styler';
import { once } from 'vs/base/common/functional';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { ViewPane, IViewPaneOptions } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { URI } from 'vs/base/common/uri';

class TunnelTreeVirtualDelegate implements IListVirtualDelegate<ITunnelItem> {
	getHeight(element: ITunnelItem): number {
		return 22;
	}

	getTemplateId(element: ITunnelItem): string {
		return 'tunnelItemTemplate';
	}
}

export interface ITunnelViewModel {
	onForwardedPortsChanged: Event<void>;
	readonly forwarded: TunnelItem[];
	readonly detected: TunnelItem[];
	readonly candidates: Promise<TunnelItem[]>;
	groups(): Promise<ITunnelGroup[]>;
}

export class TunnelViewModel extends Disposable implements ITunnelViewModel {
	private _onForwardedPortsChanged: Emitter<void> = new Emitter();
	public onForwardedPortsChanged: Event<void> = this._onForwardedPortsChanged.event;
	private model: TunnelModel;

	constructor(
		@IRemoteExplorerService remoteExplorerService: IRemoteExplorerService) {
		super();
		this.model = remoteExplorerService.tunnelModel;
		this._register(this.model.onForwardPort(() => this._onForwardedPortsChanged.fire()));
		this._register(this.model.onClosePort(() => this._onForwardedPortsChanged.fire()));
		this._register(this.model.onPortName(() => this._onForwardedPortsChanged.fire()));
	}

	async groups(): Promise<ITunnelGroup[]> {
		const groups: ITunnelGroup[] = [];
		if (this.model.forwarded.size > 0) {
			groups.push({
				label: nls.localize('remote.tunnelsView.forwarded', "Forwarded"),
				tunnelType: TunnelType.Forwarded,
				items: this.forwarded
			});
		}
		if (this.model.detected.size > 0) {
			groups.push({
				label: nls.localize('remote.tunnelsView.detected', "Detected"),
				tunnelType: TunnelType.Detected,
				items: this.detected
			});
		}
		const candidates = await this.candidates;
		if (candidates.length > 0) {
			groups.push({
				label: nls.localize('remote.tunnelsView.candidates', "Candidates"),
				tunnelType: TunnelType.Candidate,
				items: candidates
			});
		}
		groups.push({
			label: nls.localize('remote.tunnelsView.add', "Forward Port..."),
			tunnelType: TunnelType.Add,
		});
		return groups;
	}

	get forwarded(): TunnelItem[] {
		return Array.from(this.model.forwarded.values()).map(tunnel => {
			return new TunnelItem(TunnelType.Forwarded, tunnel.remote, tunnel.localAddress, tunnel.closeable, tunnel.name, tunnel.description);
		});
	}

	get detected(): TunnelItem[] {
		return Array.from(this.model.detected.values()).map(tunnel => {
			return new TunnelItem(TunnelType.Detected, tunnel.remote, tunnel.localAddress, false, tunnel.name, tunnel.description);
		});
	}

	get candidates(): Promise<TunnelItem[]> {
		return this.model.candidates.then(values => {
			const candidates: TunnelItem[] = [];
			values.forEach(value => {
				if (!this.model.forwarded.has(value.port) && !this.model.detected.has(value.port)) {
					candidates.push(new TunnelItem(TunnelType.Candidate, value.port, undefined, false, undefined, value.detail));
				}
			});
			return candidates;
		});
	}

	dispose() {
		super.dispose();
	}
}

interface ITunnelTemplateData {
	elementDisposable: IDisposable;
	container: HTMLElement;
	iconLabel: IconLabel;
	actionBar: ActionBar;
}

class TunnelTreeRenderer extends Disposable implements ITreeRenderer<ITunnelGroup | ITunnelItem, ITunnelItem, ITunnelTemplateData> {
	static readonly ITEM_HEIGHT = 22;
	static readonly TREE_TEMPLATE_ID = 'tunnelItemTemplate';

	private _actionRunner: ActionRunner | undefined;

	constructor(
		private readonly viewId: string,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IThemeService private readonly themeService: IThemeService,
		@IRemoteExplorerService private readonly remoteExplorerService: IRemoteExplorerService
	) {
		super();
	}

	set actionRunner(actionRunner: ActionRunner) {
		this._actionRunner = actionRunner;
	}

	get templateId(): string {
		return TunnelTreeRenderer.TREE_TEMPLATE_ID;
	}

	renderTemplate(container: HTMLElement): ITunnelTemplateData {
		dom.addClass(container, 'custom-view-tree-node-item');
		const iconLabel = new IconLabel(container, { supportHighlights: true });
		// dom.addClass(iconLabel.element, 'tunnel-view-label');
		const actionsContainer = dom.append(iconLabel.element, dom.$('.actions'));
		const actionBar = new ActionBar(actionsContainer, {
			// actionViewItemProvider: undefined // this.actionViewItemProvider
			actionViewItemProvider: (action: IAction) => {
				if (action instanceof MenuItemAction) {
					return this.instantiationService.createInstance(ContextAwareMenuEntryActionViewItem, action);
				}

				return undefined;
			}
		});

		return { iconLabel, actionBar, container, elementDisposable: Disposable.None };
	}

	private isTunnelItem(item: ITunnelGroup | ITunnelItem): item is ITunnelItem {
		return !!((<ITunnelItem>item).remote);
	}

	renderElement(element: ITreeNode<ITunnelGroup | ITunnelItem, ITunnelGroup | ITunnelItem>, index: number, templateData: ITunnelTemplateData): void {
		templateData.elementDisposable.dispose();
		const node = element.element;

		// reset
		templateData.actionBar.clear();
		let editableData: IEditableData | undefined;
		if (this.isTunnelItem(node)) {
			editableData = this.remoteExplorerService.getEditableData(node.remote);
			if (editableData) {
				templateData.iconLabel.element.style.display = 'none';
				this.renderInputBox(templateData.container, editableData);
			} else {
				templateData.iconLabel.element.style.display = 'flex';
				this.renderTunnel(node, templateData);
			}
		} else if ((node.tunnelType === TunnelType.Add) && (editableData = this.remoteExplorerService.getEditableData(undefined))) {
			templateData.iconLabel.element.style.display = 'none';
			this.renderInputBox(templateData.container, editableData);
		} else {
			templateData.iconLabel.element.style.display = 'flex';
			templateData.iconLabel.setLabel(node.label);
		}
	}

	private renderTunnel(node: ITunnelItem, templateData: ITunnelTemplateData) {
		templateData.iconLabel.setLabel(node.label, node.description, { title: node.label + ' - ' + node.description, extraClasses: ['tunnel-view-label'] });
		templateData.actionBar.context = node;
		const contextKeyService = this.contextKeyService.createScoped();
		contextKeyService.createKey('view', this.viewId);
		contextKeyService.createKey('tunnelType', node.tunnelType);
		contextKeyService.createKey('tunnelCloseable', node.closeable);
		const menu = this.menuService.createMenu(MenuId.TunnelInline, contextKeyService);
		this._register(menu);
		const actions: IAction[] = [];
		this._register(createAndFillInActionBarActions(menu, { shouldForwardArgs: true }, actions));
		if (actions) {
			templateData.actionBar.push(actions, { icon: true, label: false });
			if (this._actionRunner) {
				templateData.actionBar.actionRunner = this._actionRunner;
			}
		}
	}

	private renderInputBox(container: HTMLElement, editableData: IEditableData): IDisposable {
		const value = editableData.startingValue || '';
		const inputBox = new InputBox(container, this.contextViewService, {
			ariaLabel: nls.localize('remote.tunnelsView.input', "Press Enter to confirm or Escape to cancel."),
			validationOptions: {
				validation: (value) => {
					const content = editableData.validationMessage(value);
					if (!content) {
						return null;
					}

					return {
						content,
						formatContent: true,
						type: MessageType.ERROR
					};
				}
			},
			placeholder: editableData.placeholder || ''
		});
		const styler = attachInputBoxStyler(inputBox, this.themeService);

		inputBox.value = value;
		inputBox.focus();
		inputBox.select({ start: 0, end: editableData.startingValue ? editableData.startingValue.length : 0 });

		const done = once((success: boolean, finishEditing: boolean) => {
			inputBox.element.style.display = 'none';
			const value = inputBox.value;
			dispose(toDispose);
			if (finishEditing) {
				editableData.onFinish(value, success);
			}
		});

		const toDispose = [
			inputBox,
			dom.addStandardDisposableListener(inputBox.inputElement, dom.EventType.KEY_DOWN, (e: IKeyboardEvent) => {
				if (e.equals(KeyCode.Enter)) {
					if (inputBox.validate()) {
						done(true, true);
					}
				} else if (e.equals(KeyCode.Escape)) {
					done(false, true);
				}
			}),
			dom.addDisposableListener(inputBox.inputElement, dom.EventType.BLUR, () => {
				done(inputBox.isInputValid(), true);
			}),
			styler
		];

		return toDisposable(() => {
			done(false, false);
		});
	}

	disposeElement(resource: ITreeNode<ITunnelGroup | ITunnelItem, ITunnelGroup | ITunnelItem>, index: number, templateData: ITunnelTemplateData): void {
		templateData.elementDisposable.dispose();
	}

	disposeTemplate(templateData: ITunnelTemplateData): void {
		templateData.actionBar.dispose();
		templateData.elementDisposable.dispose();
	}
}

class TunnelDataSource implements IAsyncDataSource<ITunnelViewModel, ITunnelItem | ITunnelGroup> {
	hasChildren(element: ITunnelViewModel | ITunnelItem | ITunnelGroup) {
		if (element instanceof TunnelViewModel) {
			return true;
		} else if (element instanceof TunnelItem) {
			return false;
		} else if ((<ITunnelGroup>element).items) {
			return true;
		}
		return false;
	}

	getChildren(element: ITunnelViewModel | ITunnelItem | ITunnelGroup) {
		if (element instanceof TunnelViewModel) {
			return element.groups();
		} else if (element instanceof TunnelItem) {
			return [];
		} else if ((<ITunnelGroup>element).items) {
			return (<ITunnelGroup>element).items!;
		}
		return [];
	}
}

enum TunnelType {
	Candidate = 'Candidate',
	Detected = 'Detected',
	Forwarded = 'Forwarded',
	Add = 'Add'
}

interface ITunnelGroup {
	tunnelType: TunnelType;
	label: string;
	items?: ITunnelItem[] | Promise<ITunnelItem[]>;
}

interface ITunnelItem {
	tunnelType: TunnelType;
	remote: number;
	localAddress?: string;
	name?: string;
	closeable?: boolean;
	readonly description?: string;
	readonly label: string;
}

class TunnelItem implements ITunnelItem {
	constructor(
		public tunnelType: TunnelType,
		public remote: number,
		public localAddress?: string,
		public closeable?: boolean,
		public name?: string,
		private _description?: string,
	) { }
	get label(): string {
		if (this.name) {
			return nls.localize('remote.tunnelsView.forwardedPortLabel0', "{0}", this.name);
		} else if (this.localAddress) {
			return nls.localize('remote.tunnelsView.forwardedPortLabel2', "{0} to {1}", this.remote, this.localAddress);
		} else {
			return nls.localize('remote.tunnelsView.forwardedPortLabel3', "{0} not forwarded", this.remote);
		}
	}

	get description(): string | undefined {
		if (this._description) {
			return this._description;
		} else if (this.name) {
			return nls.localize('remote.tunnelsView.forwardedPortDescription0', "{0} to {1}", this.remote, this.localAddress);
		}
		return undefined;
	}
}

export const TunnelTypeContextKey = new RawContextKey<TunnelType>('tunnelType', TunnelType.Add);
export const TunnelCloseableContextKey = new RawContextKey<boolean>('tunnelCloseable', false);

export class TunnelPanel extends ViewPane {
	static readonly ID = '~remote.tunnelPanel';
	static readonly TITLE = nls.localize('remote.tunnel', "Tunnels");
	private tree!: WorkbenchAsyncDataTree<any, any, any>;
	private tunnelTypeContext: IContextKey<TunnelType>;
	private tunnelCloseableContext: IContextKey<boolean>;

	private titleActions: IAction[] = [];
	private readonly titleActionsDisposable = this._register(new MutableDisposable());

	constructor(
		protected viewModel: ITunnelViewModel,
		options: IViewPaneOptions,
		@IKeybindingService protected keybindingService: IKeybindingService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IContextKeyService protected contextKeyService: IContextKeyService,
		@IConfigurationService protected configurationService: IConfigurationService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IOpenerService protected openerService: IOpenerService,
		@IQuickInputService protected quickInputService: IQuickInputService,
		@ICommandService protected commandService: ICommandService,
		@IMenuService private readonly menuService: IMenuService,
		@INotificationService private readonly notificationService: INotificationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IThemeService private readonly themeService: IThemeService,
		@IRemoteExplorerService private readonly remoteExplorerService: IRemoteExplorerService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService);
		this.tunnelTypeContext = TunnelTypeContextKey.bindTo(contextKeyService);
		this.tunnelCloseableContext = TunnelCloseableContextKey.bindTo(contextKeyService);

		const scopedContextKeyService = this._register(this.contextKeyService.createScoped());
		scopedContextKeyService.createKey('view', TunnelPanel.ID);

		const titleMenu = this._register(this.menuService.createMenu(MenuId.TunnelTitle, scopedContextKeyService));
		const updateActions = () => {
			this.titleActions = [];
			this.titleActionsDisposable.value = createAndFillInActionBarActions(titleMenu, undefined, this.titleActions);
			this.updateActions();
		};

		this._register(titleMenu.onDidChange(updateActions));
		updateActions();

		this._register(toDisposable(() => {
			this.titleActions = [];
		}));

	}

	protected renderBody(container: HTMLElement): void {
		dom.addClass(container, '.tree-explorer-viewlet-tree-view');
		const treeContainer = document.createElement('div');
		dom.addClass(treeContainer, 'customview-tree');
		dom.addClass(treeContainer, 'file-icon-themable-tree');
		dom.addClass(treeContainer, 'show-file-icons');
		container.appendChild(treeContainer);
		const renderer = new TunnelTreeRenderer(TunnelPanel.ID, this.menuService, this.contextKeyService, this.instantiationService, this.contextViewService, this.themeService, this.remoteExplorerService);
		this.tree = this.instantiationService.createInstance(WorkbenchAsyncDataTree,
			'RemoteTunnels',
			treeContainer,
			new TunnelTreeVirtualDelegate(),
			[renderer],
			new TunnelDataSource(),
			{
				keyboardSupport: true,
				collapseByDefault: (e: ITunnelItem | ITunnelGroup): boolean => {
					return false;
				},
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (item: ITunnelItem | ITunnelGroup) => {
						return item.label;
					}
				},
				multipleSelectionSupport: false
			}
		);
		const actionRunner: ActionRunner = new ActionRunner();
		renderer.actionRunner = actionRunner;

		this._register(this.tree.onContextMenu(e => this.onContextMenu(e, actionRunner)));

		this.tree.setInput(this.viewModel);
		this._register(this.viewModel.onForwardedPortsChanged(() => {
			this.tree.updateChildren(undefined, true);
		}));

		const navigator = this._register(new TreeResourceNavigator2(this.tree, { openOnFocus: false, openOnSelection: false }));

		this._register(Event.debounce(navigator.onDidOpenResource, (last, event) => event, 75, true)(e => {
			if (e.element && (e.element.tunnelType === TunnelType.Add)) {
				this.commandService.executeCommand(ForwardPortAction.ID);
			}
		}));

		this._register(this.remoteExplorerService.onDidChangeEditable(async e => {
			const isEditing = !!this.remoteExplorerService.getEditableData(e);

			if (!isEditing) {
				dom.removeClass(treeContainer, 'highlight');
			}

			await this.tree.updateChildren(undefined, false);

			if (isEditing) {
				dom.addClass(treeContainer, 'highlight');
			} else {
				this.tree.domFocus();
			}
		}));
	}

	private get contributedContextMenu(): IMenu {
		const contributedContextMenu = this.menuService.createMenu(MenuId.TunnelContext, this.tree.contextKeyService);
		this._register(contributedContextMenu);
		return contributedContextMenu;
	}

	getActions(): IAction[] {
		return this.titleActions;
	}

	focus(): void {
		super.focus();
		this.tree.domFocus();
	}

	private onContextMenu(treeEvent: ITreeContextMenuEvent<ITunnelItem | ITunnelGroup>, actionRunner: ActionRunner): void {
		if (!(treeEvent.element instanceof TunnelItem)) {
			return;
		}
		const node: ITunnelItem | null = treeEvent.element;
		const event: UIEvent = treeEvent.browserEvent;

		event.preventDefault();
		event.stopPropagation();

		this.tree!.setFocus([node]);
		this.tunnelTypeContext.set(node.tunnelType);
		this.tunnelCloseableContext.set(!!node.closeable);

		const actions: IAction[] = [];
		this._register(createAndFillInContextMenuActions(this.contributedContextMenu, { shouldForwardArgs: true }, actions, this.contextMenuService));

		this.contextMenuService.showContextMenu({
			getAnchor: () => treeEvent.anchor,
			getActions: () => actions,
			getActionViewItem: (action) => {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				if (keybinding) {
					return new ActionViewItem(action, action, { label: true, keybinding: keybinding.getLabel() });
				}
				return undefined;
			},
			onHide: (wasCancelled?: boolean) => {
				if (wasCancelled) {
					this.tree!.domFocus();
				}
			},
			getActionsContext: () => node,
			actionRunner
		});
	}

	protected layoutBody(height: number, width: number): void {
		this.tree.layout(height, width);
	}

	getActionViewItem(action: IAction): IActionViewItem | undefined {
		return action instanceof MenuItemAction ? new ContextAwareMenuEntryActionViewItem(action, this.keybindingService, this.notificationService, this.contextMenuService) : undefined;
	}
}

export class TunnelPanelDescriptor implements IViewDescriptor {
	readonly id = TunnelPanel.ID;
	readonly name = TunnelPanel.TITLE;
	readonly ctorDescriptor: { ctor: any, arguments?: any[] };
	readonly canToggleVisibility = true;
	readonly hideByDefault = false;
	readonly workspace = true;
	readonly group = 'details@0';
	readonly remoteAuthority?: string | string[];

	constructor(viewModel: ITunnelViewModel, environmentService: IWorkbenchEnvironmentService) {
		this.ctorDescriptor = { ctor: TunnelPanel, arguments: [viewModel] };
		this.remoteAuthority = environmentService.configuration.remoteAuthority ? environmentService.configuration.remoteAuthority.split('+')[0] : undefined;
	}
}

namespace LabelTunnelAction {
	export const ID = 'remote.tunnel.label';
	export const LABEL = nls.localize('remote.tunnel.label', "Set Label");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const remoteExplorerService = accessor.get(IRemoteExplorerService);
				remoteExplorerService.setEditable(arg.remote, {
					onFinish: (value, success) => {
						if (success) {
							remoteExplorerService.tunnelModel.name(arg.remote, value);
						}
						remoteExplorerService.setEditable(arg.remote, null);
					},
					validationMessage: () => null,
					placeholder: nls.localize('remote.tunnelsView.labelPlaceholder', "Port label"),
					startingValue: arg.name
				});
			}
			return;
		};
	}
}

namespace ForwardPortAction {
	export const ID = 'remote.tunnel.forward';
	export const LABEL = nls.localize('remote.tunnel.forward', "Forward Port");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			const remoteExplorerService = accessor.get(IRemoteExplorerService);
			if (arg instanceof TunnelItem) {
				remoteExplorerService.tunnelModel.forward(arg.remote);
			} else {
				remoteExplorerService.setEditable(undefined, {
					onFinish: (value, success) => {
						if (success) {
							remoteExplorerService.tunnelModel.forward(Number(value));
						}
						remoteExplorerService.setEditable(undefined, null);
					},
					validationMessage: (value) => {
						const asNumber = Number(value);
						if ((value === '') || isNaN(asNumber) || (asNumber < 0) || (asNumber > 65535)) {
							return nls.localize('remote.tunnelsView.portNumberValid', "Port number is invalid");
						}
						return null;
					},
					placeholder: nls.localize('remote.tunnelsView.forwardPortPlaceholder', "Port number")
				});
			}
		};
	}
}

namespace ClosePortAction {
	export const ID = 'remote.tunnel.close';
	export const LABEL = nls.localize('remote.tunnel.close', "Stop Forwarding Port");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const remoteExplorerService = accessor.get(IRemoteExplorerService);
				await remoteExplorerService.tunnelModel.close(arg.remote);
			}
		};
	}
}

namespace OpenPortInBrowserAction {
	export const ID = 'remote.tunnel.open';
	export const LABEL = nls.localize('remote.tunnel.open', "Open in Browser");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const model = accessor.get(IRemoteExplorerService).tunnelModel;
				const openerService = accessor.get(IOpenerService);
				const tunnel = model.forwarded.has(arg.remote) ? model.forwarded.get(arg.remote) : model.detected.get(arg.remote);
				let address: string | undefined;
				if (tunnel && tunnel.localAddress && (address = model.address(tunnel.remote))) {
					return openerService.open(URI.parse('http://' + address));
				}
				return Promise.resolve();
			}
		};
	}
}

namespace CopyAddressAction {
	export const ID = 'remote.tunnel.copyAddress';
	export const LABEL = nls.localize('remote.tunnel.copyAddress', "Copy Address");

	export function handler(): ICommandHandler {
		return async (accessor, arg) => {
			if (arg instanceof TunnelItem) {
				const model = accessor.get(IRemoteExplorerService).tunnelModel;
				const clipboard = accessor.get(IClipboardService);
				const address = model.address(arg.remote);
				if (address) {
					await clipboard.writeText(address.toString());
				}
			}
		};
	}
}

CommandsRegistry.registerCommand(LabelTunnelAction.ID, LabelTunnelAction.handler());
CommandsRegistry.registerCommand(ForwardPortAction.ID, ForwardPortAction.handler());
CommandsRegistry.registerCommand(ClosePortAction.ID, ClosePortAction.handler());
CommandsRegistry.registerCommand(OpenPortInBrowserAction.ID, OpenPortInBrowserAction.handler());
CommandsRegistry.registerCommand(CopyAddressAction.ID, CopyAddressAction.handler());

MenuRegistry.appendMenuItem(MenuId.TunnelTitle, ({
	group: 'navigation',
	order: 0,
	command: {
		id: ForwardPortAction.ID,
		title: ForwardPortAction.LABEL,
		icon: { id: 'codicon/plus' }
	}
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 0,
	command: {
		id: CopyAddressAction.ID,
		title: CopyAddressAction.LABEL,
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded), TunnelTypeContextKey.isEqualTo(TunnelType.Detected))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 1,
	command: {
		id: OpenPortInBrowserAction.ID,
		title: OpenPortInBrowserAction.LABEL,
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded), TunnelTypeContextKey.isEqualTo(TunnelType.Detected))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 2,
	command: {
		id: LabelTunnelAction.ID,
		title: LabelTunnelAction.LABEL,
	},
	when: TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded)
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 1,
	command: {
		id: ForwardPortAction.ID,
		title: ForwardPortAction.LABEL,
	},
	when: TunnelTypeContextKey.isEqualTo(TunnelType.Candidate)
}));
MenuRegistry.appendMenuItem(MenuId.TunnelContext, ({
	group: '0_manage',
	order: 3,
	command: {
		id: ClosePortAction.ID,
		title: ClosePortAction.LABEL,
	},
	when: TunnelCloseableContextKey
}));

MenuRegistry.appendMenuItem(MenuId.TunnelInline, ({
	order: 0,
	command: {
		id: OpenPortInBrowserAction.ID,
		title: OpenPortInBrowserAction.LABEL,
		icon: { id: 'codicon/globe' }
	},
	when: ContextKeyExpr.or(TunnelTypeContextKey.isEqualTo(TunnelType.Forwarded), TunnelTypeContextKey.isEqualTo(TunnelType.Detected))
}));
MenuRegistry.appendMenuItem(MenuId.TunnelInline, ({
	order: 0,
	command: {
		id: ForwardPortAction.ID,
		title: ForwardPortAction.LABEL,
		icon: { id: 'codicon/plus' }
	},
	when: TunnelTypeContextKey.isEqualTo(TunnelType.Candidate)
}));
MenuRegistry.appendMenuItem(MenuId.TunnelInline, ({
	order: 2,
	command: {
		id: ClosePortAction.ID,
		title: ClosePortAction.LABEL,
		icon: { id: 'codicon/x' }
	},
	when: TunnelCloseableContextKey
}));
